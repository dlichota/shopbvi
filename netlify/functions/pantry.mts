/**
 * Google Sheets sync for Larder Flow.
 *
 *   GET  /api/pantry  → current rows from the sheet
 *   POST /api/pantry  → apply a batch of offline-queued changes, return fresh rows
 *
 * The sheet is the source of truth. Rows are matched by item name (normalised),
 * so the app never depends on row order and a person can freely sort or reorder
 * the sheet by hand. Columns are discovered from the sheet's own header row —
 * only the columns that exist are read or written, so extra columns of your own
 * are left untouched.
 *
 * Required environment variables:
 *   GOOGLE_SHEETS_SPREADSHEET_ID     the long id from the sheet URL
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL     ...@...iam.gserviceaccount.com
 *   GOOGLE_SERVICE_ACCOUNT_KEY       the service account's PEM private key
 * Optional:
 *   GOOGLE_SHEETS_TAB                tab name (defaults to the first tab)
 *   PANTRY_SYNC_TOKEN                shared secret required to read/write
 */
import { createSign } from 'node:crypto';
import type { Config, Context } from '@netlify/functions';

type Field = 'item' | 'type' | 'location' | 'stock' | 'minStock' | 'inCart' | 'notes';

interface PantryItem {
  id: string;
  item: string;
  type: string;
  location: string;
  stock: number;
  minStock: number;
  inCart: boolean;
  notes: string;
}

/** Header aliases, lowercased. First match wins, so put canonical names first. */
const FIELD_ALIASES: Record<Field, string[]> = {
  item: ['item', 'name', 'product', 'ingredient', 'items'],
  type: ['type', 'category', 'group', 'kind'],
  location: ['location', 'place', 'storage', 'where', 'area'],
  stock: ['stock', 'qty', 'quantity', 'count', 'on hand', 'onhand', 'in stock', 'amount'],
  minStock: ['min stock', 'minstock', 'min', 'minimum', 'min qty', 'par', 'par level', 'reorder', 'reorder level', 'restock at'],
  inCart: ['in cart', 'incart', 'cart', 'to buy', 'buy', 'shopping', 'checked', 'basket'],
  notes: ['notes', 'note', 'comment', 'comments', 'brand', 'detail', 'details'],
};

/** Written only when the sheet is completely empty and we have to seed a header row. */
const DEFAULT_HEADERS: Array<[Field, string]> = [
  ['item', 'Item'],
  ['type', 'Type'],
  ['location', 'Location'],
  ['stock', 'Stock'],
  ['minStock', 'Min Stock'],
  ['inCart', 'In Cart'],
  ['notes', 'Notes'],
];

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
/** Batch ceiling. The app chunks its queue to match, so this rejects nothing it sends. */
const MAX_OPS = 200;
const MAX_TEXT = 200;
/** Upper bound on what one request will read, so a runaway grid can't stall the sync. */
const MAX_ROWS = 20000;
const MAX_COLUMNS = 100;
/** No single upstream call may sit there long enough to eat the function's whole budget. */
const REQUEST_TIMEOUT_MS = 8000;

let cachedToken: { token: string; expiresAt: number } | null = null;

class SyncError extends Error {
  status: number;
  hint?: string;
  constructor(message: string, status = 500, hint?: string) {
    super(message);
    this.status = status;
    this.hint = hint;
  }
}

/* ---------------------------------------------------------------- helpers */

function normaliseKey(name: unknown): string {
  return String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function columnLetter(index: number): string {
  let letter = '';
  let n = index;
  while (n >= 0) {
    letter = String.fromCharCode((n % 26) + 65) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}

/** Sheet names go inside single quotes in A1 notation; embedded quotes double up. */
function quoteTab(tab: string): string {
  return `'${tab.replace(/'/g, "''")}'`;
}

function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  const text = String(value ?? '').trim().toLowerCase();
  return ['true', 'yes', 'y', '1', 'x', '✓', '✔', 'buy', 'in cart'].includes(text);
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function clampText(value: unknown): string {
  return String(value ?? '').trim().slice(0, MAX_TEXT);
}

function clampCount(value: unknown): number {
  const n = Math.trunc(toNumber(value));
  return Math.min(Math.max(n, 0), 100000);
}

/* ------------------------------------------------------------------ auth */

/**
 * A hung upstream is indistinguishable from a slow one until the function's own
 * budget runs out and the caller gets a bare 502 with nothing to act on. Cap the
 * wait instead and say which call gave up: the app keeps its queue either way.
 */
async function timedFetch(url: string, init: RequestInit, what: string): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    const name = (error as Error)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new SyncError(`${what} did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds.`, 504,
        'Nothing was lost — your changes are still queued on the device. Try again in a moment.');
    }
    throw new SyncError(`Could not reach ${what}.`, 502);
  }
}

/** First of several environment variable names that actually has a value. */
function envAny(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** Accepts the bare id or a whole sheet URL pasted straight from the browser. */
function spreadsheetIdFrom(value: string | undefined): string | undefined {
  return value?.match(/\/d\/([\w-]+)/)?.[1] ?? value;
}

/** Some people paste the downloaded key file whole rather than picking fields out. */
function serviceAccountFile(): { client_email?: string; private_key?: string } {
  const raw = envAny('GOOGLE_SERVICE_ACCOUNT_JSON', 'GOOGLE_APPLICATION_CREDENTIALS_JSON', 'GOOGLE_CREDENTIALS');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function readConfig() {
  // The canonical names come first; the rest are the names people reasonably
  // reach for — the fields as they appear in Google's downloaded key file, and
  // the whole file pasted into one variable.
  const file = serviceAccountFile();
  const spreadsheetId = spreadsheetIdFrom(
    envAny('GOOGLE_SHEETS_SPREADSHEET_ID', 'GOOGLE_SHEET_ID', 'SPREADSHEET_ID', 'SHEET_ID'));
  const clientEmail =
    envAny('GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_CLIENT_EMAIL', 'client_email') || file.client_email?.trim();
  // Netlify's UI stores newlines escaped, so accept both real and escaped ones.
  const privateKey =
    (envAny('GOOGLE_SERVICE_ACCOUNT_KEY', 'GOOGLE_PRIVATE_KEY', 'private_key') || file.private_key)
      ?.replace(/\\n/g, '\n').trim();
  const tab = envAny('GOOGLE_SHEETS_TAB', 'GOOGLE_SHEET_TAB') || '';
  const syncToken = envAny('PANTRY_SYNC_TOKEN') || '';
  return { spreadsheetId, clientEmail, privateKey, tab, syncToken };
}

async function getAccessToken(clientEmail: string, privateKey: string): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;

  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;

  let signature: string;
  try {
    signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey).toString('base64url');
  } catch {
    throw new SyncError('Could not sign the Google auth request.', 500,
      'GOOGLE_SERVICE_ACCOUNT_KEY must be the full PEM private key, including the BEGIN and END lines.');
  }

  const response = await timedFetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  }, 'Google sign-in');

  if (!response.ok) {
    throw new SyncError('Google rejected the service account credentials.', 502,
      'Check GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_KEY, and that the Google Sheets API is enabled for the project.');
  }

  const data = (await response.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.token;
}

async function sheetsFetch(path: string, token: string, init: RequestInit = {}) {
  const response = await timedFetch(`${SHEETS_API}${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  }, 'Google Sheets');

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    if (response.status === 403) {
      throw new SyncError('Google denied access to the spreadsheet.', 403,
        'Share the sheet with the service account email address, giving it Editor access.');
    }
    if (response.status === 404) {
      throw new SyncError('That spreadsheet could not be found.', 404,
        'Check GOOGLE_SHEETS_SPREADSHEET_ID — it is the long id between /d/ and /edit in the sheet URL.');
    }
    throw new SyncError(`Google Sheets API error (${response.status}).`, 502, detail.slice(0, 200));
  }

  return response.json();
}

/* ---------------------------------------------------------------- sheet io */

interface SheetState {
  tabTitle: string;
  sheetId: number;
  title: string;
  columns: Partial<Record<Field, number>>;
  headerRow: string[];
  rows: string[][];
  /** normalised item name → 1-based sheet row number */
  rowByKey: Map<string, number>;
  items: PantryItem[];
  /** Things the app should tell someone about, e.g. a tab too big to read whole. */
  warnings: string[];
}

function mapColumns(headerRow: string[]): Partial<Record<Field, number>> {
  const columns: Partial<Record<Field, number>> = {};
  headerRow.forEach((rawHeader, index) => {
    const header = normaliseKey(rawHeader);
    if (!header) return;
    for (const [field, aliases] of Object.entries(FIELD_ALIASES) as Array<[Field, string[]]>) {
      if (columns[field] === undefined && aliases.includes(header)) {
        columns[field] = index;
        return;
      }
    }
  });
  return columns;
}

function rowToItem(row: string[], columns: Partial<Record<Field, number>>): PantryItem | null {
  const cell = (field: Field) => (columns[field] === undefined ? '' : row[columns[field] as number] ?? '');
  const name = clampText(cell('item'));
  if (!name) return null;
  return {
    id: normaliseKey(name),
    item: name,
    type: clampText(cell('type')),
    location: clampText(cell('location')),
    stock: clampCount(cell('stock')),
    minStock: columns.minStock === undefined ? 1 : clampCount(cell('minStock')),
    inCart: toBoolean(cell('inCart')),
    notes: clampText(cell('notes')),
  };
}

async function readSheet(token: string, spreadsheetId: string, preferredTab: string): Promise<SheetState> {
  const meta = (await sheetsFetch(
    `/${spreadsheetId}?fields=properties.title,sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))`,
    token
  )) as {
    properties: { title: string };
    sheets: Array<{
      properties: { sheetId: number; title: string; gridProperties?: { rowCount?: number; columnCount?: number } };
    }>;
  };

  const tab = preferredTab
    ? meta.sheets.find((s) => s.properties.title === preferredTab)
    : meta.sheets[0];

  if (!tab) {
    throw new SyncError(`The tab "${preferredTab}" does not exist in that spreadsheet.`, 404,
      `Available tabs: ${meta.sheets.map((s) => s.properties.title).join(', ')}`);
  }

  const tabTitle = tab.properties.title;

  // Read the tab's actual extent rather than a fixed window. A row or column
  // left outside the range is invisible to the app, and an edit to an item it
  // could not see would append a duplicate row instead of updating the
  // original — so when the grid is bigger than we can read, say so out loud.
  const grid = tab.properties.gridProperties ?? {};
  const gridRows = Math.max(1, grid.rowCount ?? MAX_ROWS);
  const gridColumns = Math.max(1, grid.columnCount ?? MAX_COLUMNS);
  const rowLimit = Math.min(gridRows, MAX_ROWS);
  const columnLimit = Math.min(gridColumns, MAX_COLUMNS);

  const warnings: string[] = [];
  if (gridRows > rowLimit) {
    warnings.push(`Only the first ${rowLimit} rows of "${tabTitle}" are synced — the tab has ${gridRows}.`);
  }
  if (gridColumns > columnLimit) {
    warnings.push(
      `Only columns A–${columnLetter(columnLimit - 1)} of "${tabTitle}" are synced — the tab has ${gridColumns}.`
    );
  }

  const values = (await sheetsFetch(
    `/${spreadsheetId}/values/${encodeURIComponent(
      `${quoteTab(tabTitle)}!A1:${columnLetter(columnLimit - 1)}${rowLimit}`
    )}?valueRenderOption=UNFORMATTED_VALUE`,
    token
  )) as { values?: string[][] };

  const allRows = values.values ?? [];
  const headerRow = (allRows[0] ?? []).map((cell) => String(cell ?? ''));
  const columns = mapColumns(headerRow);
  const rows = allRows.slice(1);

  const items: PantryItem[] = [];
  const rowByKey = new Map<string, number>();

  if (columns.item !== undefined) {
    rows.forEach((row, index) => {
      const item = rowToItem(row, columns);
      if (!item) return;
      // First occurrence wins if the sheet has duplicate names.
      if (rowByKey.has(item.id)) return;
      rowByKey.set(item.id, index + 2); // +1 for header, +1 for 1-based rows
      items.push(item);
    });
  }

  return { tabTitle, sheetId: tab.properties.sheetId, title: meta.properties.title, columns, headerRow, rows, rowByKey, items, warnings };
}

async function seedHeaderRow(token: string, spreadsheetId: string, tabTitle: string) {
  await sheetsFetch(
    `/${spreadsheetId}/values/${encodeURIComponent(`${quoteTab(tabTitle)}!A1`)}?valueInputOption=USER_ENTERED`,
    token,
    { method: 'PUT', body: JSON.stringify({ values: [DEFAULT_HEADERS.map(([, label]) => label)] }) }
  );
}

function itemToRow(item: PantryItem, columns: Partial<Record<Field, number>>, width: number): unknown[] {
  const row = new Array(width).fill('');
  const put = (field: Field, value: unknown) => {
    const index = columns[field];
    if (index !== undefined) row[index] = value;
  };
  put('item', item.item);
  put('type', item.type);
  put('location', item.location);
  put('stock', item.stock);
  put('minStock', item.minStock);
  put('inCart', item.inCart);
  put('notes', item.notes);
  return row;
}

/* ------------------------------------------------------------------- ops */

type Op =
  | { type: 'upsert'; item: PantryItem }
  | { type: 'delete'; id: string };

function parseOps(body: unknown): Op[] {
  const raw = (body as { ops?: unknown })?.ops;
  if (!Array.isArray(raw)) throw new SyncError('Expected an "ops" array.', 400);
  if (raw.length > MAX_OPS) throw new SyncError(`Too many changes in one request (limit ${MAX_OPS}).`, 400);

  const ops: Op[] = [];
  for (const entry of raw as Array<Record<string, unknown>>) {
    if (entry?.type === 'delete') {
      const id = normaliseKey(entry.id);
      if (id) ops.push({ type: 'delete', id });
      continue;
    }
    if (entry?.type === 'upsert') {
      const name = clampText(entry.item);
      if (!name) continue;
      ops.push({
        type: 'upsert',
        item: {
          id: normaliseKey(name),
          item: name,
          type: clampText(entry.itemType ?? entry.category),
          location: clampText(entry.location),
          stock: clampCount(entry.stock),
          minStock: clampCount(entry.minStock),
          inCart: Boolean(entry.inCart),
          notes: clampText(entry.notes),
        },
      });
    }
  }
  return ops;
}

async function applyOps(token: string, spreadsheetId: string, state: SheetState, ops: Op[]) {
  const width = Math.max(state.headerRow.length, 1);
  const updates: Array<{ range: string; values: unknown[][] }> = [];
  const appends: unknown[][] = [];
  const deleteRows: number[] = [];
  // Track rows claimed by appends so two upserts of the same new item don't
  // create two rows in a single batch.
  const pendingAppends = new Map<string, number>();

  for (const op of ops) {
    if (op.type === 'delete') {
      const row = state.rowByKey.get(op.id);
      if (row) deleteRows.push(row);
      continue;
    }

    const row = state.rowByKey.get(op.item.id);
    if (row) {
      const rowValues = itemToRow(op.item, state.columns, width);
      // Write each mapped column individually so unmapped columns (formulas,
      // notes of your own) are never overwritten.
      for (const field of Object.keys(FIELD_ALIASES) as Field[]) {
        const index = state.columns[field];
        if (index === undefined) continue;
        if (field === 'item') continue; // the name is the key; never rewrite it
        updates.push({
          range: `${quoteTab(state.tabTitle)}!${columnLetter(index)}${row}`,
          values: [[rowValues[index]]],
        });
      }
    } else if (pendingAppends.has(op.item.id)) {
      appends[pendingAppends.get(op.item.id) as number] = itemToRow(op.item, state.columns, width);
    } else {
      pendingAppends.set(op.item.id, appends.length);
      appends.push(itemToRow(op.item, state.columns, width));
    }
  }

  if (updates.length) {
    await sheetsFetch(`/${spreadsheetId}/values:batchUpdate`, token, {
      method: 'POST',
      body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: updates }),
    });
  }

  if (appends.length) {
    await sheetsFetch(
      `/${spreadsheetId}/values/${encodeURIComponent(`${quoteTab(state.tabTitle)}!A1`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      token,
      { method: 'POST', body: JSON.stringify({ values: appends }) }
    );
  }

  if (deleteRows.length) {
    // Delete bottom-up so earlier row numbers stay valid.
    const ordered = [...new Set(deleteRows)].sort((a, b) => b - a);
    await sheetsFetch(`/${spreadsheetId}:batchUpdate`, token, {
      method: 'POST',
      body: JSON.stringify({
        requests: ordered.map((row) => ({
          deleteDimension: {
            range: { sheetId: state.sheetId, dimension: 'ROWS', startIndex: row - 1, endIndex: row },
          },
        })),
      }),
    });
  }

  return { updated: updates.length, added: appends.length, deleted: deleteRows.length };
}

/* --------------------------------------------------------------- handler */

export default async (req: Request, _context: Context) => {
  const noStore = { 'Cache-Control': 'no-store' };
  const { spreadsheetId, clientEmail, privateKey, tab, syncToken } = readConfig();

  if (!spreadsheetId || !clientEmail || !privateKey) {
    const missing = [
      !spreadsheetId && 'GOOGLE_SHEETS_SPREADSHEET_ID',
      !clientEmail && 'GOOGLE_SERVICE_ACCOUNT_EMAIL',
      !privateKey && 'GOOGLE_SERVICE_ACCOUNT_KEY',
    ].filter(Boolean) as string[];
    return Response.json(
      {
        connected: false,
        reason: 'not_configured',
        message: 'Google Sheets sync is not configured for this site yet.',
        missing,
        // Name the variables in the hint too: the app shows the hint on the
        // status pill, and "not configured" on its own leaves no way to tell
        // which of the three is actually absent.
        hint: `Set ${missing.join(' and ')} in the site's environment variables, then redeploy. See SETUP.md.`,
      },
      { headers: noStore }
    );
  }

  if (syncToken && req.headers.get('x-pantry-token') !== syncToken) {
    return Response.json(
      { connected: false, reason: 'unauthorized', message: 'A sync key is required for this larder.' },
      { status: 401, headers: noStore }
    );
  }

  try {
    const token = await getAccessToken(clientEmail, privateKey);
    let state = await readSheet(token, spreadsheetId, tab);

    // A brand-new empty sheet gets the canonical header row so syncing can start.
    if (state.columns.item === undefined) {
      if (state.headerRow.length === 0 && state.rows.length === 0) {
        await seedHeaderRow(token, spreadsheetId, state.tabTitle);
        state = await readSheet(token, spreadsheetId, tab);
      } else {
        throw new SyncError(
          `No item-name column found in the "${state.tabTitle}" tab.`,
          422,
          'Give one column a header like "Item", "Name" or "Product" in the first row.'
        );
      }
    }

    if (req.method === 'GET') {
      return Response.json(
        {
          connected: true,
          spreadsheet: { title: state.title, tab: state.tabTitle },
          columns: Object.keys(state.columns),
          items: state.items,
          warnings: state.warnings,
          syncedAt: new Date().toISOString(),
        },
        { headers: noStore }
      );
    }

    if (req.method === 'POST') {
      const body = await req.json().catch(() => {
        throw new SyncError('Invalid JSON body.', 400);
      });
      const ops = parseOps(body);
      const result = ops.length ? await applyOps(token, spreadsheetId, state, ops) : { updated: 0, added: 0, deleted: 0 };
      const fresh = ops.length ? await readSheet(token, spreadsheetId, tab) : state;

      return Response.json(
        {
          connected: true,
          spreadsheet: { title: fresh.title, tab: fresh.tabTitle },
          applied: result,
          items: fresh.items,
          warnings: fresh.warnings,
          syncedAt: new Date().toISOString(),
        },
        { headers: noStore }
      );
    }

    return new Response('Method not allowed', { status: 405, headers: { ...noStore, Allow: 'GET, POST' } });
  } catch (error) {
    const syncError = error instanceof SyncError ? error : null;
    if (!syncError) console.error('Pantry sync failed:', error);
    return Response.json(
      {
        connected: false,
        reason: 'error',
        message: syncError?.message ?? 'Sync failed unexpectedly.',
        hint: syncError?.hint,
      },
      { status: syncError?.status ?? 500, headers: noStore }
    );
  }
};

export const config: Config = {
  path: '/api/pantry',
};
