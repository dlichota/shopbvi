/**
 * Exercises the Google Sheets sync function against a mocked Sheets API.
 * No network and no credentials: a throwaway RSA key signs the JWT, and the
 * Google endpoints are stubbed so we can assert on the exact calls made.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

/** A deliberately awkward sheet: alias headers, and a user column we must not touch. */
const HEADERS = ['Name', 'Category', 'Where', 'Qty', 'Par', 'To buy', 'Brand', 'My own column'];
const INITIAL_ROWS = [
  ['Eggs', 'Eggs', 'Fridge', 0, 1, 'FALSE', '', 'keep me'],
  ['Basmati rice', 'Grains', 'Cupboard', 1, 1, 'no', 'Tilda', 'mine too'],
  ['Lemons', 'Fruit', 'Fresh produce', 3, 2, 'FALSE', '', ''],
];

let headers: string[] = [...HEADERS];
let rows: any[][] = INITIAL_ROWS.map((row) => [...row]);
let grid = { rowCount: 1000, columnCount: HEADERS.length };
let calls: Array<{ href: string; method: string; body: any }> = [];
let handler: (req: Request, context: any) => Promise<Response>;

before(async () => {
  process.env.GOOGLE_SHEETS_SPREADSHEET_ID = 'SHEET123';
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'robot@example.iam.gserviceaccount.com';
  process.env.GOOGLE_SERVICE_ACCOUNT_KEY = privateKey;

  globalThis.fetch = (async (url: any, init: RequestInit = {}) => {
    const href = url.toString();
    // The token request is form-encoded; everything else is JSON.
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ href, method: init.method || 'GET', body });

    if (href.startsWith('https://oauth2.googleapis.com/token')) {
      return Response.json({ access_token: 'fake-token', expires_in: 3600 });
    }
    if (href.includes('?fields=properties.title')) {
      return Response.json({
        properties: { title: 'Home Pantry' },
        sheets: [{ properties: { sheetId: 42, title: 'Larder', gridProperties: grid } }],
      });
    }
    if (href.includes('/values/') && (init.method || 'GET') === 'GET') {
      return Response.json({ values: headers.length ? [headers, ...rows] : [] });
    }
    if (href.includes('batchUpdate') || href.includes(':append')) return Response.json({});
    throw new Error(`unexpected fetch: ${href}`);
  }) as typeof fetch;

  ({ default: handler } = await import('../netlify/functions/pantry.mts'));
});

beforeEach(() => {
  headers = [...HEADERS];
  rows = INITIAL_ROWS.map((row) => [...row]);
  grid = { rowCount: 1000, columnCount: HEADERS.length };
  calls = [];
  delete process.env.PANTRY_SYNC_TOKEN;
});

/** Finds a captured request, failing the test rather than returning undefined. */
function callTo(needle: string) {
  const call = calls.find((c) => c.href.includes(needle));
  assert.ok(call, `expected a request to ${needle}`);
  return call;
}

const get = () => handler(new Request('https://site.test/api/pantry'), {});
const post = (ops: any[], init: RequestInit = {}) =>
  handler(new Request('https://site.test/api/pantry', { method: 'POST', body: JSON.stringify({ ops }), ...init }), {});

test('reads rows through whatever headers the sheet happens to use', async () => {
  const data = await (await get()).json();

  assert.equal(data.connected, true);
  assert.equal(data.spreadsheet.tab, 'Larder');
  assert.deepEqual(data.items.find((i: any) => i.id === 'eggs'), {
    id: 'eggs', item: 'Eggs', type: 'Eggs', location: 'Fridge',
    stock: 0, minStock: 1, inCart: false, notes: '',
  });

  const rice = data.items.find((i: any) => i.id === 'basmati rice');
  assert.equal(rice.notes, 'Tilda', 'Brand maps to notes');
  assert.equal(rice.inCart, false, '"no" reads as false');
});

test('reads the tab through its own extent rather than a fixed window', async () => {
  const data = await (await get()).json();

  assert.deepEqual(data.warnings, [], 'a sheet that fits has nothing to report');
  assert.ok(
    decodeURIComponent(callTo('/values/').href).includes("'Larder'!A1:H1000"),
    'the range follows the tab\'s own row and column count'
  );
});

test('a tab too big to read whole is reported, not silently clipped', async () => {
  grid = { rowCount: 60000, columnCount: 500 };
  const data = await (await get()).json();

  assert.equal(data.connected, true, 'still usable, just partial');
  assert.equal(data.warnings.length, 2);
  assert.match(data.warnings[0], /first 20000 rows .* has 60000/);
  assert.match(data.warnings[1], /columns A–CV .* has 500/);
  assert.ok(decodeURIComponent(callTo('/values/').href).includes("'Larder'!A1:CV20000"));
});

test('updating an item writes only its mapped columns', async () => {
  await post([
    { type: 'upsert', id: 'eggs', item: 'Eggs', itemType: 'Eggs', location: 'Fridge', stock: 6, minStock: 1, inCart: true, notes: 'free range' },
  ]);

  const update = callTo('values:batchUpdate');
  const ranges = update.body.data.map((d: any) => d.range);

  assert.ok(ranges.every((r: any) => r.endsWith('2')), 'only the matched row is written');
  assert.ok(!ranges.some((r: any) => r.includes('!A')), 'the name column is the key and is never rewritten');
  assert.ok(!ranges.some((r: any) => r.includes('!H')), 'a column the app does not know about is left alone');
  assert.deepEqual(update.body.data.find((d: any) => d.range === "'Larder'!D2").values, [[6]]);
  assert.deepEqual(update.body.data.find((d: any) => d.range === "'Larder'!F2").values, [[true]]);
});

test('an unknown item becomes a new row of the right shape', async () => {
  const data = await (await post([
    { type: 'upsert', id: 'oat milk', item: 'Oat milk', itemType: 'Dairy', location: 'Fridge', stock: 2, minStock: 1, inCart: false, notes: '' },
  ])).json();

  assert.equal(data.applied.added, 1);
  const append = callTo(':append');
  assert.deepEqual(append.body.values, [['Oat milk', 'Dairy', 'Fridge', 2, 1, false, '', '']]);
});

test('deleting removes the matching sheet row, bottom-up', async () => {
  await post([{ type: 'delete', id: 'basmati rice' }, { type: 'delete', id: 'lemons' }]);

  const del = callTo('SHEET123:batchUpdate');
  const deleted = del.body.requests.map((r: any) => r.deleteDimension.range.startIndex);
  assert.deepEqual(deleted, [3, 2], 'later rows first, so earlier row numbers stay valid');
  assert.equal(del.body.requests[0].deleteDimension.range.sheetId, 42);
});

test('two changes to the same new item produce one row', async () => {
  await post([
    { type: 'upsert', id: 'oat milk', item: 'Oat milk', itemType: 'Dairy', location: 'Fridge', stock: 1, minStock: 1, inCart: false, notes: '' },
    { type: 'upsert', id: 'oat milk', item: 'Oat milk', itemType: 'Dairy', location: 'Fridge', stock: 4, minStock: 1, inCart: false, notes: '' },
  ]);

  const append = callTo(':append');
  assert.equal(append.body.values.length, 1);
  assert.equal(append.body.values[0][3], 4, 'the later change wins');
});

test('a sheet with no item-name column explains itself', async () => {
  headers = ['Thing', 'Amount'];
  rows = [];
  const response = await get();

  assert.equal(response.status, 422);
  assert.match((await response.json()).message, /item-name column/);
});

test('an upstream that stops answering fails fast and says so', async () => {
  const realFetch = globalThis.fetch;
  // What fetch throws once its AbortSignal.timeout fires.
  globalThis.fetch = (async () => {
    throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  }) as typeof fetch;

  const response = await get();
  const data = await response.json();

  assert.equal(response.status, 504);
  assert.match(data.message, /did not answer within/);
  assert.match(data.hint, /still queued/, 'and says the queued changes are safe');

  globalThis.fetch = realFetch;
});

test('a sync key, when set, is required', async () => {
  process.env.PANTRY_SYNC_TOKEN = 'secret';

  assert.equal((await get()).status, 401);
  const allowed = await handler(
    new Request('https://site.test/api/pantry', { headers: { 'x-pantry-token': 'secret' } }), {});
  assert.equal(allowed.status, 200);
});

test('missing configuration is reported, not thrown', async () => {
  const saved = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  delete process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

  const data = await (await get()).json();
  assert.equal(data.connected, false);
  assert.equal(data.reason, 'not_configured');
  assert.deepEqual(data.missing, ['GOOGLE_SHEETS_SPREADSHEET_ID']);

  process.env.GOOGLE_SHEETS_SPREADSHEET_ID = saved;
});

/**
 * Credentials can be named several reasonable ways. Each of these restores the
 * canonical variables afterwards so the rest of the suite is unaffected.
 */
test("the key file's own field names work as variable names", async () => {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  process.env.client_email = email;
  process.env.private_key = key;

  assert.equal((await (await get()).json()).connected, true);

  delete process.env.client_email;
  delete process.env.private_key;
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = email;
  process.env.GOOGLE_SERVICE_ACCOUNT_KEY = key;
});

test('the whole downloaded key file in one variable works too', async () => {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: email, private_key: key });

  assert.equal((await (await get()).json()).connected, true);

  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = email;
  process.env.GOOGLE_SERVICE_ACCOUNT_KEY = key;
});

test('a pasted sheet URL works in place of the bare id', async () => {
  const saved = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  process.env.GOOGLE_SHEETS_SPREADSHEET_ID = 'https://docs.google.com/spreadsheets/d/SHEET123/edit#gid=0';

  assert.equal((await (await get()).json()).connected, true);
  callTo('/spreadsheets/SHEET123'); // asserts the id was pulled out of the URL

  process.env.GOOGLE_SHEETS_SPREADSHEET_ID = saved;
});
