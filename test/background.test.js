/*
 * Tests for src/background.js: local network protection, download limits and caching.
 * Runs the real worker code in Node with stubs for chrome.* and fetch.
 *
 * Usage: node test/background.test.js   (Node 18+)
 */
'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const MB = 1024 * 1024;

/** Loads a fresh copy of the worker. `serve(url)` returns { status, type, body | stream, length, finalUrl }. */
function loadWorker(serve) {
  let onMessage = null;
  const log = { fetched: [], pulledBytes: 0, active: 0, maxActive: 0 };
  const ctx = {
    URL, Blob, Response, ReadableStream, AbortController, Promise, console, Map, Array, String, Number,
    setTimeout, clearTimeout,
    chrome: {
      runtime: { onMessage: { addListener: (f) => { onMessage = f; } }, onInstalled: { addListener() {} }, getManifest() {} },
      commands: { onCommand: { addListener() {} } },
      action: {},
      tabs: {
        onRemoved: { addListener: (f) => { log.onRemoved = f; } },
        sendMessage: async () => ({ ready: true, active: true, nativeDark: false, host: 'secret.example.com' })
      }
    },
    createImageBitmap: async () => ({ width: 10, height: 10, close() {} }),
    OffscreenCanvas: class {
      getContext() { return { drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(10 * 10 * 4) }) }; }
    },
    fetch: async (url, opts) => {
      log.fetched.push(url);
      log.active++;
      log.maxActive = Math.max(log.maxActive, log.active);
      const r = await serve(url, opts);
      await new Promise((ok) => setTimeout(ok, 5));
      log.active--;
      const headers = new Headers({ 'content-type': r.type || 'image/png' });
      if (r.length !== undefined) headers.set('content-length', String(r.length));
      let body = r.body;
      if (r.streamBytes) {
        let left = r.streamBytes;
        body = new ReadableStream({
          pull(c) {
            if (left <= 0) { c.close(); return; }
            const n = Math.min(left, 64 * 1024);
            left -= n;
            log.pulledBytes += n;
            c.enqueue(new Uint8Array(n));
          }
        });
      }
      const res = new Response(body === undefined ? null : body, { status: r.status || 200, headers });
      Object.defineProperty(res, 'url', { value: r.finalUrl || url });
      return res;
    }
  };
  ctx.globalThis = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'src/shared.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'src/background.js'), 'utf8'), ctx);
  const ask = (url, page = 'https://news.example.com/', tabId = 1, documentId = 'doc-' + tabId) =>
    new Promise((resolve) =>
      onMessage({ type: 'analyzeImage', url }, { tab: { id: tabId, url: page }, url: page, frameId: 0, documentId }, resolve));
  const message = (msg, sender) => new Promise((resolve) => {
    if (onMessage(msg, sender, resolve) !== true) resolve(undefined);
  });
  return { ask, message, log };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const svg = { type: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' };

/* ---------------------------------------------------- local network */

const PUBLIC = 'https://news.example.com/';
const hostCases = [
  ['https://cdn.example.net/a.svg', PUBLIC, true],
  ['http://127.0.0.1/a.svg', PUBLIC, false],
  ['http://0x7f.1/a.svg', PUBLIC, false],
  ['http://2130706433/a.svg', PUBLIC, false],
  ['http://localhost:8080/a.svg', PUBLIC, false],
  ['http://foo.localhost/a.svg', PUBLIC, false],
  ['http://192.168.1.1/a.svg', PUBLIC, false],
  ['http://10.0.0.5/a.svg', PUBLIC, false],
  ['http://172.20.1.1/a.svg', PUBLIC, false],
  ['http://172.32.1.1/a.svg', PUBLIC, true],
  ['http://169.254.169.254/a.svg', PUBLIC, false],
  ['http://100.64.0.1/a.svg', PUBLIC, false],
  ['http://[::1]/a.svg', PUBLIC, false],
  ['http://[::ffff:127.0.0.1]/a.svg', PUBLIC, false],
  ['http://[fd00::1]/a.svg', PUBLIC, false],
  ['http://[fe80::1]/a.svg', PUBLIC, false],
  ['http://[2001:db8::1]/a.svg', PUBLIC, true],
  ['http://[::ffff:8.8.8.8]/a.svg', PUBLIC, true],
  ['http://router/a.svg', PUBLIC, false],
  ['http://nas.local/a.svg', PUBLIC, false],
  ['http://printer.lan/a.svg', PUBLIC, false],
  ['http://192.168.1.1/a.svg', 'http://192.168.1.10/admin', true],
  ['http://nas.local/a.svg', 'http://intranet/', true],
  ['http://10.0.0.5/a.svg', 'file:///C:/x.html', true]
];
for (const [url, page, allowed] of hostCases) {
  test(`${allowed ? 'allows' : 'blocks'} ${url} from ${page}`, async () => {
    const { ask, log } = loadWorker(() => svg);
    const r = await ask(url, page);
    assert.strictEqual(log.fetched.length > 0, allowed, 'fetch made');
    assert.strictEqual(!!r, allowed, 'result returned');
  });
}

test('drops the answer when a public URL redirects into the local network', async () => {
  const { ask } = loadWorker(() => ({ ...svg, finalUrl: 'http://192.168.1.1/x.svg' }));
  assert.strictEqual(await ask('https://evil.example.com/r.svg'), null);
});

test('a result fetched for a local page is not served to a public page', async () => {
  const { ask } = loadWorker(() => svg);
  assert.ok(await ask('http://10.1.1.1/c.svg', 'http://10.1.1.2/'));
  assert.strictEqual(await ask('http://10.1.1.1/c.svg', PUBLIC), null);
});

/* ---------------------------------------------------- download limits */

test('refuses a file whose Content-Length is over the limit without reading it', async () => {
  const { ask, log } = loadWorker(() => ({ streamBytes: 200 * MB, length: 200 * MB }));
  assert.strictEqual(await ask('https://cdn.example.net/big.png'), null);
  assert.ok(log.pulledBytes <= 1 * MB, `pulled ${log.pulledBytes} bytes`);
});

test('stops reading a body without Content-Length once it is over the limit', async () => {
  const { ask, log } = loadWorker(() => ({ streamBytes: 200 * MB }));
  assert.strictEqual(await ask('https://cdn.example.net/big.png'), null);
  assert.ok(log.pulledBytes <= 9 * MB, `pulled ${log.pulledBytes / MB} MB`);
});

test('SVG over 1 MB is refused while reading', async () => {
  const { ask, log } = loadWorker(() => ({ type: 'image/svg+xml', streamBytes: 50 * MB }));
  assert.strictEqual(await ask('https://cdn.example.net/big.svg'), null);
  assert.ok(log.pulledBytes <= 2 * MB, `pulled ${log.pulledBytes / MB} MB`);
});

test('a normal image is still analysed', async () => {
  const { ask } = loadWorker(() => ({ streamBytes: 100 * 1024 }));
  const r = await ask('https://cdn.example.net/logo.png');
  assert.ok(r && typeof r.lum === 'number', JSON.stringify(r));
});

test('non-image content types are not read', async () => {
  const { ask, log } = loadWorker(() => ({ type: 'text/html', streamBytes: 5 * MB }));
  assert.strictEqual(await ask('https://cdn.example.net/page'), null);
  assert.ok(log.pulledBytes <= 1 * MB, `pulled ${log.pulledBytes / MB} MB`);
});

test('downloads at most 4 pictures at a time', async () => {
  const { ask, log } = loadWorker(() => svg);
  await Promise.all(Array.from({ length: 30 }, (_, i) => ask(`https://cdn.example.net/${i}.svg`)));
  assert.strictEqual(log.fetched.length, 30);
  assert.ok(log.maxActive <= 4, `max parallel ${log.maxActive}`);
});

test('a page may have pictures from at most 40 hosts analysed', async () => {
  const { ask } = loadWorker(() => svg);
  for (let i = 0; i < 40; i++) assert.ok(await ask(`https://h${i}.example.net/a.svg`), `host ${i}`);
  assert.strictEqual(await ask('https://h40.example.net/a.svg'), null, '41st host refused');
  assert.ok(await ask('https://h3.example.net/b.svg'), 'known host still allowed');
  assert.ok(await ask('https://h40.example.net/a.svg', PUBLIC, 1, 'other-doc'), 'another page has its own limit');
});

test('public names of local addresses cannot be probed in bulk', async () => {
  const { ask, log } = loadWorker(() => svg);
  const results = [];
  for (let i = 1; i <= 100; i++) results.push(await ask(`http://192.168.1.${i}.nip.io/logo.svg`));
  assert.ok(log.fetched.length <= 40, `fetched ${log.fetched.length}`);
});

test('one tab with many slow pictures does not hold up another tab', async () => {
  const done = [];
  const { ask } = loadWorker(async (url) => {
    await new Promise((ok) => setTimeout(ok, url.includes('slow') ? 30 : 1));
    return svg;
  });
  const slow = Array.from({ length: 40 }, (_, i) => ask(`https://slow.example.net/${i}.svg`, PUBLIC, 1)
    .then(() => done.push('slow')));
  await new Promise((ok) => setTimeout(ok, 5));
  const fast = ask('https://fast.example.net/a.svg', PUBLIC, 2).then(() => done.push('fast'));
  await Promise.all([...slow, fast]);
  const at = done.indexOf('fast');
  assert.ok(at < 10, `other tab finished as #${at + 1} of ${done.length}`);
});

test('a tab queue is limited, the rest is not analysed', async () => {
  const { ask, log } = loadWorker(async () => {
    await new Promise((ok) => setTimeout(ok, 2));
    return svg;
  });
  const results = await Promise.all(Array.from({ length: 200 }, (_, i) =>
    ask(`https://cdn.example.net/${i}.svg`)));
  assert.ok(results.filter((r) => r === null).length >= 40, 'excess refused');
  assert.ok(log.fetched.length <= 160, `fetched ${log.fetched.length}`);
});

test('an iframe learns only whether the page around it is themed', async () => {
  const { message } = loadWorker(() => svg);
  const r = await message({ type: 'getTopState' }, { tab: { id: 1 }, frameId: 3, url: 'https://ads.example.org/' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), { active: true });
});

/* ---------------------------------------------------- cache */

test('SVG text is not kept in the cache, other results are', async () => {
  const { ask, log } = loadWorker((url) => (url.endsWith('.svg') ? svg : { streamBytes: 1024 }));
  await ask('https://cdn.example.net/a.svg');
  await new Promise((ok) => setTimeout(ok, 0));
  await ask('https://cdn.example.net/a.svg');
  assert.strictEqual(log.fetched.filter((u) => u.endsWith('a.svg')).length, 2, 'svg fetched again');
  await ask('https://cdn.example.net/b.png');
  await ask('https://cdn.example.net/b.png');
  assert.strictEqual(log.fetched.filter((u) => u.endsWith('b.png')).length, 1, 'png served from cache');
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`ok   ${t.name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${t.name}\n     ${e.message}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
