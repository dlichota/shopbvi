/**
 * Runs the real page script from index.html against a stubbed DOM, so the
 * offline queue and sheet sync can be exercised without a browser.
 *
 * The script is extracted from index.html rather than copied, so these tests
 * fail if the app's behaviour drifts.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
const pageScript = html.match(/<script>([\s\S]*?)<\/script>/)[1];

/* ------------------------------------------------------------- DOM stub */
function makeEl(tag = 'div') {
  const listeners = {};
  const el = {
    tagName: tag, children: [], dataset: {}, style: {}, attributes: {},
    textContent: '', innerHTML: '', value: '', disabled: false,
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
      toggle(c, force) { (force === undefined ? !this._set.has(c) : force) ? this._set.add(c) : this._set.delete(c); },
    },
    setAttribute(name, value) { el.attributes[name] = String(value); },
    getAttribute(name) { return name in el.attributes ? el.attributes[name] : null; },
    focus() {}, reset() {}, scrollIntoView() {},
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
    appendChild(child) { el.children.push(child); },
    replaceChildren(...nodes) { el.children = nodes; },
    dispatch(type, event = {}) { (listeners[type] || []).forEach((fn) => fn({ target: el, preventDefault() {}, ...event })); },
    click() { el.dispatch('click'); },
    closest: () => null,
    /* Card markup is assigned as an innerHTML string, which this stub does not
       parse. Hand back a scratch element so painting a card has somewhere to
       write: these tests are about the queue and the sync, not the pixels. */
    querySelector: () => makeEl(), querySelectorAll: () => [],
  };
  return el;
}

const ELEMENT_IDS = ['list','emptyState','emptyText','clearSearchBtn','searchInput','needCount','cartCount','allCount','viewTitle','viewHint','installBtn','itemForm','itemName','itemType','itemLocation','itemStock','itemMin','itemNotes','submitBtn','cancelEditBtn','formHint','resetBtn','syncBadge','syncAnnounce','toast','toastMsg','toastAction'];

/** Simulates a tap on one of the buttons rendered inside an item card. */
function tapCardButton(list, action, id) {
  // The handler patches the tapped button's own card rather than re-rendering,
  // so the stand-in button has to answer closest('.card') the way a real one does.
  const card = makeEl('article');
  const button = { dataset: { action, id }, closest: (sel) => (sel === '.card' ? card : null) };
  list.dispatch('click', { target: { closest: () => button } });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

/* ------------------------------------------------------------ harness */
function launch({ items = null, online = true, fetchImpl } = {}) {
  const ids = Object.fromEntries(ELEMENT_IDS.map((id) => [id, makeEl()]));
  const chips = ['shopping','all','out','buy','cart'].map((filter) => Object.assign(makeEl('button'), { dataset: { filter } }));
  const navbtns = ['shopping','inventory','cart','add'].map((nav) => Object.assign(makeEl('button'), { dataset: { nav } }));

  const document = {
    documentElement: makeEl('html'),
    visibilityState: 'visible',
    getElementById: (id) => ids[id] || makeEl(),
    createElement: (tag) => makeEl(tag),
    addEventListener() {},
    querySelector(sel) {
      if (sel === '[data-theme-toggle]') return makeEl('button');
      const chip = sel.match(/^\.chip\[data-filter="(.+)"\]$/);
      if (chip) return chips.find((c) => c.dataset.filter === chip[1]) || null;
      const nav = sel.match(/^\.navbtn\[data-nav="(.+)"\]$/);
      if (nav) return navbtns.find((n) => n.dataset.nav === nav[1]) || null;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '.chip') return chips;
      if (sel === '.navbtn') return navbtns;
      if (sel === 'meta[name="theme-color"]') return [makeEl('meta'), makeEl('meta')];
      return [];
    },
  };

  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  /** Stands in for the Google Sheet the function would be talking to. */
  let sheet = items ?? [
    { id: 'eggs', item: 'Eggs', type: 'Eggs', location: 'Fridge', stock: 0, minStock: 1, inCart: false, notes: '' },
    { id: 'lemons', item: 'Lemons', type: 'Fruit', location: 'Fresh produce', stock: 3, minStock: 2, inCart: false, notes: '' },
  ];
  const requests = [];

  const defaultFetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ url, method: init.method || 'GET', body });
    for (const op of body?.ops ?? []) {
      if (op.type === 'delete') { sheet = sheet.filter((i) => i.id !== op.id); continue; }
      const next = { id: op.id, item: op.item, type: op.itemType, location: op.location, stock: op.stock, minStock: op.minStock, inCart: op.inCart, notes: op.notes };
      const at = sheet.findIndex((i) => i.id === op.id);
      at === -1 ? sheet.push(next) : (sheet[at] = next);
    }
    return {
      status: 200,
      json: async () => ({ connected: true, spreadsheet: { title: 'Home Pantry', tab: 'Larder' }, items: sheet }),
    };
  };

  const navigator = { onLine: online, userAgent: 'node-test' };
  const window = { addEventListener() {}, scrollTo() {} };

  /* Real timers, but unref'd: the app schedules its own retries after a failed
     sync, and a live timer chain would keep the test runner from ever exiting. */
  const timeout = (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  };

  const factory = new Function(
    'document', 'localStorage', 'navigator', 'window', 'matchMedia', 'fetch', 'setInterval', 'setTimeout', 'confirm', 'prompt', 'location',
    `${pageScript}
     return { getItems: () => items, getQueue: () => queue, sync, syncState, commitPendingDelete,
              startEdit, resetForm, submitForm: () => itemForm.dispatch('submit'), getEditingId: () => editingId };`
  );

  const app = factory(
    document, localStorage, navigator, window, () => ({ matches: false }),
    fetchImpl || defaultFetch, () => 0, timeout, () => true, () => null, { search: '' }
  );

  return { app, ids, chips, navbtns, navigator, store, requests, getSheet: () => sheet };
}

/** Drains pending promises without relying on timers, which some tests mock. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/* -------------------------------------------------------------- tests */
test('opening the app pulls the sheet over the bundled sample data', async () => {
  const { app, ids, requests } = launch();
  await settle();

  assert.equal(requests[0].method, 'GET');
  assert.deepEqual(app.getItems().map((i) => i.id), ['eggs', 'lemons']);
  assert.equal(ids.syncBadge.dataset.state, 'ok');
  assert.equal(ids.syncBadge.textContent, 'Synced just now');
});

test('edits made offline are queued, one op per item', async () => {
  const { app, ids, navigator, store } = launch();
  await settle();

  navigator.onLine = false;
  tapCardButton(ids.list, 'increment', 'eggs');
  tapCardButton(ids.list, 'toggle-cart', 'lemons');
  tapCardButton(ids.list, 'increment', 'eggs');

  assert.equal(app.getQueue().length, 2, 'two items touched → two ops, not three');
  assert.equal(app.getItems().find((i) => i.id === 'eggs').stock, 2, 'both taps applied locally');
  assert.equal(ids.syncBadge.textContent, 'Offline · 2 queued');
  assert.equal(JSON.parse(store.get('larder-flow:queue:v1')).length, 2, 'the queue survives a reload');
});

test('reconnecting flushes queued changes to the sheet', async () => {
  const { app, ids, navigator, requests, getSheet } = launch();
  await settle();

  navigator.onLine = false;
  tapCardButton(ids.list, 'increment', 'eggs');
  tapCardButton(ids.list, 'toggle-cart', 'lemons');

  requests.length = 0;
  navigator.onLine = true;
  await app.sync({ force: true });
  await settle();

  const post = requests.find((r) => r.method === 'POST');
  assert.equal(post.body.ops.length, 2);
  assert.equal(post.body.ops.find((o) => o.id === 'eggs').stock, 1, 'sends final state, not a change log');
  assert.equal(post.body.ops.find((o) => o.id === 'lemons').inCart, true);
  assert.equal(app.getQueue().length, 0, 'queue clears once accepted');
  assert.equal(getSheet().find((i) => i.id === 'eggs').stock, 1);
  assert.equal(ids.syncBadge.dataset.state, 'ok');
});

test('deleting an item removes it from the sheet once the undo window closes', async () => {
  const { app, ids, getSheet } = launch();
  await settle();

  tapCardButton(ids.list, 'remove', 'lemons');
  await app.sync({ force: true });
  await settle();

  assert.equal(ids.toastAction.textContent, 'Undo');
  assert.ok(!app.getItems().some((i) => i.id === 'lemons'), 'gone from the list straight away');
  assert.ok(getSheet().some((i) => i.id === 'lemons'), 'but the row is untouched while undo is offered');

  app.commitPendingDelete();
  await app.sync({ force: true });
  await settle();

  assert.ok(!getSheet().some((i) => i.id === 'lemons'));
  assert.ok(!app.getItems().some((i) => i.id === 'lemons'));
});

test('undoing a delete puts the item back and never touches the sheet', async () => {
  const { app, ids, requests, getSheet } = launch();
  await settle();

  tapCardButton(ids.list, 'remove', 'lemons');
  requests.length = 0;
  ids.toastAction.click();
  await app.sync({ force: true });
  await settle();

  assert.ok(app.getItems().some((i) => i.id === 'lemons'), 'restored locally');
  assert.ok(getSheet().some((i) => i.id === 'lemons'), 'the row was never deleted');
  assert.ok(!requests.some((r) => r.body?.ops?.some((o) => o.type === 'delete')), 'no delete was ever sent');
});

test('a held delete survives the app being closed', async () => {
  const { app, ids, store } = launch();
  await settle();

  tapCardButton(ids.list, 'remove', 'lemons');
  app.commitPendingDelete(); // what leaving the app does

  assert.deepEqual(JSON.parse(store.get('larder-flow:queue:v1')), [{ type: 'delete', id: 'lemons' }]);
});

test('a big backlog goes up in batches the function will accept', async () => {
  const many = Array.from({ length: 205 }, (_, n) => ({
    id: `item ${n}`, item: `Item ${n}`, type: 'Dry', location: 'Cupboard',
    stock: 1, minStock: 1, inCart: false, notes: '',
  }));
  const { app, ids, navigator, requests } = launch({ items: many });
  await settle();

  navigator.onLine = false;
  many.forEach((item) => tapCardButton(ids.list, 'increment', item.id));
  assert.equal(app.getQueue().length, 205);

  requests.length = 0;
  navigator.onLine = true;
  await app.sync({ force: true });
  await settle();

  assert.equal(requests[0].body.ops.length, 200, 'never more than the function will take');
  assert.equal(app.getQueue().length, 5, 'the remainder is kept, not dropped');

  await app.sync({ force: true });
  await settle();

  assert.equal(requests[1].body.ops.length, 5);
  assert.equal(app.getQueue().length, 0);
});

test('a sheet bigger than the sync can read is reported, not hidden', async () => {
  const { app, ids } = launch({
    fetchImpl: async () => ({
      status: 200,
      json: async () => ({
        connected: true,
        spreadsheet: { title: 'Home Pantry', tab: 'Larder' },
        items: [],
        warnings: ['Only the first 20000 rows of "Larder" are synced — the tab has 60000.'],
      }),
    }),
  });
  await settle();

  assert.match(ids.toastMsg.textContent, /Only the first 20000 rows/);
  assert.equal(app.syncState.message, 'Only the first 20000 rows of "Larder" are synced — the tab has 60000.');
  assert.equal(ids.syncBadge.dataset.state, 'ok', 'a clipped sheet is a warning, not a failure');
});

test('the app stays usable when the sheet cannot be reached', async () => {
  const { app, ids } = launch({ fetchImpl: async () => { throw new Error('network down'); } });
  await settle();

  tapCardButton(ids.list, 'increment', 'eggs');
  await settle();

  assert.equal(ids.syncBadge.dataset.state, 'error');
  assert.ok(app.getItems().length > 0, 'the local larder still renders');
  assert.ok(app.getQueue().length > 0, 'the change is held for later');
});

test('an unconfigured site quietly stays local', async () => {
  const { app, ids } = launch({
    fetchImpl: async () => ({ status: 200, json: async () => ({ connected: false, reason: 'not_configured', message: 'not configured' }) }),
  });
  await settle();

  assert.equal(app.syncState.connected, false);
  assert.equal(ids.syncBadge.dataset.state, 'local');
  assert.equal(ids.syncBadge.textContent, 'On this device');
  assert.ok(app.getItems().length > 0, 'sample data still available');
});

test('a failed sync retries itself rather than stranding the queue', async (t) => {
  // Mock timers before launching, so the app's own retry timer is one we control.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reachable = false;
  const { app, ids } = launch({
    fetchImpl: async () => {
      if (!reachable) throw new Error('network down');
      return { status: 200, json: async () => ({ connected: true, spreadsheet: { title: 'Home Pantry', tab: 'Larder' }, items: [] }) };
    },
  });

  await flush();
  assert.equal(ids.syncBadge.dataset.state, 'error');
  assert.equal(app.syncState.connected, false);

  reachable = true;
  t.mock.timers.tick(5001); // the first backoff window
  await flush();

  assert.equal(ids.syncBadge.dataset.state, 'ok', 'recovered without anyone tapping anything');
  assert.equal(app.syncState.connected, true);
  t.mock.timers.reset();
});

test('editing an item through the form keeps the values it already had', async () => {
  const { app, ids } = launch({
    items: [{ id: 'lemons', item: 'Lemons', type: 'Fruit', location: 'Fresh produce', stock: 3, minStock: 2, inCart: false, notes: 'Unwaxed' }],
  });
  await settle();

  tapCardButton(ids.list, 'edit', 'lemons');
  assert.equal(ids.itemName.value, 'Lemons');
  assert.equal(ids.itemStock.value, 3, 'the form is loaded with the item, not with blank defaults');
  assert.equal(ids.itemNotes.value, 'Unwaxed');
  assert.equal(ids.submitBtn.textContent, 'Save changes');

  ids.itemMin.value = 4; // the one thing actually being changed
  ids.itemForm.dispatch('submit');

  const saved = app.getItems().find((i) => i.id === 'lemons');
  assert.equal(saved.minStock, 4);
  assert.equal(saved.stock, 3, 'the stock count is not zeroed by the edit');
  assert.equal(saved.notes, 'Unwaxed', 'nor are the notes wiped');
  assert.equal(app.getQueue().at(-1).stock, 3, 'and the sheet is told the same');
  assert.equal(app.getEditingId(), null, 'the form goes back to adding');
});

test('the bottom nav and the filter chips stay in step', async () => {
  const { chips, navbtns } = launch();
  await settle();

  const chip = (name) => chips.find((c) => c.dataset.filter === name);
  const nav = (name) => navbtns.find((n) => n.dataset.nav === name);

  chip('out').click();
  assert.ok(nav('shopping').classList.contains('active'), 'Out is still a shopping view');
  assert.equal(nav('shopping').getAttribute('aria-current'), 'true');
  assert.equal(nav('inventory').getAttribute('aria-current'), 'false');

  nav('cart').click();
  assert.ok(chip('cart').classList.contains('active'));
  assert.equal(chip('cart').getAttribute('aria-pressed'), 'true');
  assert.equal(chip('out').getAttribute('aria-pressed'), 'false');
});

test('a search that finds nothing says what it looked for', async () => {
  const { ids } = launch();
  await settle();

  ids.searchInput.value = 'zzz';
  ids.searchInput.dispatch('input');

  assert.ok(!ids.emptyState.classList.contains('hidden'));
  assert.match(ids.emptyText.textContent, /zzz/);
  assert.ok(!ids.clearSearchBtn.classList.contains('hidden'));

  ids.clearSearchBtn.click();
  assert.equal(ids.searchInput.value, '');
  assert.ok(ids.emptyState.classList.contains('hidden'));
});

test('types and locations the sheet uses are offered by the form', async () => {
  const { ids } = launch({
    items: [{ id: 'kimchi', item: 'Kimchi', type: 'Ferments', location: 'Back fridge', stock: 1, minStock: 1, inCart: false, notes: '' }],
  });
  await settle();

  const values = (select) => select.children.map((option) => option.value);
  assert.ok(values(ids.itemType).includes('Ferments'), "the sheet's own categories are selectable");
  assert.ok(values(ids.itemLocation).includes('Back fridge'));
  assert.ok(values(ids.itemType).includes(''), 'and an item can have none');
});
