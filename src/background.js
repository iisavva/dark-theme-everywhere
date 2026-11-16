/*
 * Background worker: analyses cross-origin images, keeps the toolbar icon in sync,
 * relays the top page state to iframes and handles keyboard shortcuts.
 */
if (typeof importScripts === 'function' && typeof DT === 'undefined') importScripts('shared.js', '../ui/i18n.js');

/* Interface language of the toolbar title (the `language` setting, English by default). */
let current = null; // settings
DT.loadSettings().then((s) => { current = s; I18N.setLang(s.language); }, () => {});
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if (changes.language) I18N.setLang(changes.language.newValue);
  if (changes.sites || changes.exclusions || changes.language) {
    current = await DT.loadSettings();
    refreshBadges();
  }
});

/* ---------------------------------------------------- badge: site rules */
/*
 * The toolbar icon shows when the current site has its own rule: "ON" (always dark), "OFF"
 * (never dark); a site with elements left as on the site but no rule shows their number.
 */
function badgeFor(url) {
  const host = DT.hostFromUrl(url || '');
  if (!host || !current) return { text: '', color: '#000' };
  const ov = DT.findOverride(current, host);
  if (ov) return ov.value ? { text: I18N.t('badgeOn'), color: '#3f8f4f' } : { text: I18N.t('badgeOff'), color: '#6b7280' };
  const n = DT.exclusionsFor(current, host).length;
  return n ? { text: String(n), color: '#b07d16' } : { text: '', color: '#000' };
}

function setBadge(tabId, url) {
  const b = badgeFor(url);
  chrome.action.setBadgeText({ tabId, text: b.text }).catch(() => {});
  if (b.text) chrome.action.setBadgeBackgroundColor({ tabId, color: b.color }).catch(() => {});
}

async function refreshBadges() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) if (tab.url) setBadge(tab.id, tab.url);
  } catch (e) { /* no tabs API (tests) */ }
}

if (chrome.tabs && chrome.tabs.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.url || info.status === 'complete') setBadge(tabId, tab.url);
  });
}

/* ------------------------------------------------------- image analysis */

const statsCache = new Map();
const MAX_BYTES = 8 * 1024 * 1024;

/* ------------------------------------------ local network protection */
/*
 * The worker has <all_urls> access and is not limited by CORS, while the image URL comes from
 * the page. Without a check, any site could make the extension request addresses in the user's
 * local network (router, localhost services) and learn something about them from how its
 * pictures get themed. So private addresses are analysed only for pages that are themselves
 * in the local network (an intranet page with intranet pictures).
 */

function parseIPv4(h) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((n) => n <= 255) ? p : null;
}

function isPrivateIPv4([a, b]) {
  return a === 0 || a === 10 || a === 127 || a >= 224 ||   // this net, private, loopback, multicast/reserved
    (a === 100 && b >= 64 && b <= 127) ||                    // carrier-grade NAT
    (a === 169 && b === 254) ||                              // link-local
    (a === 172 && b >= 16 && b <= 31) ||                     // private
    (a === 192 && b === 168) ||                              // private
    (a === 192 && b === 0) ||                                // IETF protocol assignments (192.0.0.0/24 and neighbours)
    (a === 198 && (b === 18 || b === 19));                   // benchmarking
}

/** Expands an IPv6 address (without brackets) to 8 numbers, or null. */
function parseIPv6(h) {
  h = h.split('%')[0];
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (tail) {
    const v4 = parseIPv4(tail[1]);
    if (!v4) return null;
    h = h.slice(0, -tail[1].length) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = h.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const parts = head.concat(Array(halves.length === 2 ? fill : 0).fill('0'), rest);
  if (!parts.every((x) => /^[0-9a-f]{1,4}$/i.test(x))) return null;
  return parts.map((x) => parseInt(x, 16));
}

function isPrivateIPv6(h) {
  const p = parseIPv6(h);
  if (!p) return true; // unparsable: be safe
  if (p.slice(0, 7).every((x) => x === 0) && p[7] <= 1) return true;          // :: and ::1
  if (p.slice(0, 5).every((x) => x === 0) && (p[5] === 0xffff || p[5] === 0)) {  // IPv4-mapped / -compatible
    return isPrivateIPv4([p[6] >> 8, p[6] & 255, p[7] >> 8, p[7] & 255]);
  }
  if (p[0] === 0x64 && p[1] === 0xff9b) {                                      // NAT64
    return isPrivateIPv4([p[6] >> 8, p[6] & 255, p[7] >> 8, p[7] & 255]);
  }
  return (p[0] & 0xfe00) === 0xfc00 ||  // unique local fc00::/7
    (p[0] & 0xffc0) === 0xfe80 ||        // link-local fe80::/10
    (p[0] & 0xffc0) === 0xfec0 ||        // site-local (deprecated) fec0::/10
    (p[0] & 0xff00) === 0xff00;          // multicast
}

/**
 * True for addresses in the local network: localhost, private / link-local IPs, single-label
 * intranet names and the usual local-only suffixes. The URL parser has already normalised
 * IPv4 forms like 0x7f.1 or 2130706433 to 127.0.0.1.
 */
function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (h.startsWith('[')) return isPrivateIPv6(h.slice(1, -1));
  const v4 = parseIPv4(h);
  if (v4) return isPrivateIPv4(v4);
  if (!h.includes('.')) return true; // localhost, router, nas, …
  return /\.(?:localhost|local|localdomain|internal|intranet|lan|home|corp|home\.arpa)$/.test(h);
}

function isPrivateUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
    return isPrivateHost(u.hostname);
  } catch (e) {
    return true;
  }
}

/** Whether the requesting frame may analyse pictures from the local network. */
function senderIsLocal(sender) {
  const url = sender.url || (sender.tab && sender.tab.url) || '';
  if (/^file:/i.test(url)) return true;
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && isPrivateHost(u.hostname);
  } catch (e) {
    return false;
  }
}

const MAX_SVG_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;
const MAX_PARALLEL = 4;
const MAX_WAITING_PER_TAB = 150;
const MAX_HOSTS_PER_PAGE = 40;

/**
 * Reads at most `max` bytes of the body. Returns null (and cancels the download) if the body is
 * larger: the size check must happen while reading, not after the whole file has arrived.
 */
async function readLimited(res, max) {
  const declared = Number(res.headers.get('content-length'));
  if (declared > max) {
    if (res.body) res.body.cancel().catch(() => {});
    return null;
  }
  if (!res.body || !res.body.getReader) {
    const blob = await res.blob();
    return blob.size > max ? null : blob;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new Blob(chunks, { type: res.headers.get('content-type') || '' });
}

async function analyzeRemote(url, allowPrivate) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { credentials: 'omit', cache: 'force-cache', signal: ctrl.signal });
    if (!res.ok) {
      if (res.body) res.body.cancel().catch(() => {});
      return null;
    }
    // A public address may redirect into the local network: drop the answer then.
    if (!allowPrivate && res.url && isPrivateUrl(res.url)) {
      if (res.body) res.body.cancel().catch(() => {});
      return null;
    }
    const type = (res.headers.get('content-type') || '').toLowerCase();
    const svgByName = /\.svgz?(?:[?#]|$)/i.test(url) && (!type || type.includes('octet-stream') || type.includes('xml'));
    const isSvg = type.includes('svg') || svgByName;
    if (!isSvg && type && !type.startsWith('image/') && !type.includes('octet-stream')) {
      if (res.body) res.body.cancel().catch(() => {});
      return null;
    }

    const blob = await readLimited(res, isSvg ? MAX_SVG_BYTES : MAX_BYTES);
    if (!blob) return null;

    if (isSvg) {
      // SVG cannot be rasterised in a worker; the content script draws it.
      const text = await blob.text();
      return /<svg[\s>]/i.test(text) ? { svg: text } : null;
    }

    const bmp = await createImageBitmap(blob);
    const size = DT.sampleSize(bmp.width, bmp.height);
    const canvas = new OffscreenCanvas(size.w, size.h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, size.w, size.h);
    if (bmp.close) bmp.close();
    // Only statistics leave the worker, never the image itself.
    return DT.imageStats(ctx.getImageData(0, 0, size.w, size.h).data, size.w * size.h);
  } finally {
    clearTimeout(timer);
  }
}

/*
 * A page can reference thousands of pictures: download only a few at a time. Every tab has its
 * own queue and the tabs take turns, so one page with many slow pictures cannot hold up the
 * others; a tab's queue has a size limit, the rest is not analysed.
 */
let running = 0;
const queues = new Map(); // tabId -> [run]

function nextTask() {
  for (const [tabId, q] of queues) {
    const run = q.shift();
    queues.delete(tabId);
    if (q.length) queues.set(tabId, q); // move the tab to the end: round robin
    if (run) return run;
  }
  return null;
}

function limited(tabId, task) {
  return new Promise((resolve, reject) => {
    const run = () => {
      running++;
      task().then(resolve, reject).finally(() => {
        running--;
        const next = nextTask();
        if (next) next();
      });
    };
    if (running < MAX_PARALLEL) { run(); return; }
    const q = queues.get(tabId) || [];
    if (q.length >= MAX_WAITING_PER_TAB) { resolve(null); return; }
    q.push(run);
    queues.set(tabId, q);
  });
}

/*
 * Distinct picture hosts a single page may have analysed. Real pages use a few dozen at most;
 * the limit stops a page from probing many addresses through the extension (for example local
 * network devices behind public names that resolve to private addresses).
 */
const pageHosts = new Map(); // page key -> Set of hosts

function pageKey(sender) {
  const tabId = sender.tab ? sender.tab.id : -1;
  return `${tabId}|${sender.documentId || `${sender.frameId}|${sender.url || ''}`}`;
}

function hostAllowed(sender, url) {
  let host;
  try { host = new URL(url).host; } catch (e) { return false; }
  const key = pageKey(sender);
  let hosts = pageHosts.get(key);
  if (!hosts) {
    if (pageHosts.size > 500) pageHosts.delete(pageHosts.keys().next().value);
    hosts = new Set();
    pageHosts.set(key, hosts);
  }
  if (hosts.has(host)) return true;
  if (hosts.size >= MAX_HOSTS_PER_PAGE) return false;
  hosts.add(host);
  return true;
}

if (chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    queues.delete(tabId);
    for (const key of pageHosts.keys()) if (key.startsWith(tabId + '|')) pageHosts.delete(key);
  });
}

function analyzeCached(url, allowPrivate, sender) {
  if (!/^https?:/i.test(url)) return Promise.resolve(null);
  if (!allowPrivate && isPrivateUrl(url)) return Promise.resolve(null);
  if (!hostAllowed(sender, url)) return Promise.resolve(null);
  // Separate cache entries, so a result fetched for an intranet page never reaches a public one.
  const key = (allowPrivate ? 'local|' : 'public|') + url;
  if (statsCache.has(key)) return statsCache.get(key);
  const p = limited(sender.tab ? sender.tab.id : -1, () => analyzeRemote(url, allowPrivate)).catch(() => null);
  // A result dropped by the queue limit must not stay in the cache.
  p.then((r) => { if (r === null && statsCache.get(key) === p) statsCache.delete(key); });
  if (statsCache.size > 1000) statsCache.delete(statsCache.keys().next().value);
  statsCache.set(key, p);
  // SVG text can be up to 1 MB: keep it out of the cache (the content script caches the
  // statistics it computes from it, and the browser's HTTP cache keeps the file).
  p.then((r) => { if (r && r.svg && statsCache.get(key) === p) statsCache.delete(key); });
  return p;
}

/* ----------------------------------------------------------------- icon */

function iconSet(on) {
  const s = on ? 'on' : 'off';
  return { 16: `/icons/${s}-16.png`, 32: `/icons/${s}-32.png`, 48: `/icons/${s}-48.png` };
}

function setTabIcon(tabId, on) {
  chrome.action.setIcon({ tabId, path: iconSet(on) }).catch(() => {});
  chrome.action.setTitle({ tabId, title: I18N.t(on ? 'titleOn' : 'titleOff') }).catch(() => {});
}

/* ------------------------------------------------------------- messages */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !sender.tab) return;
  const tabId = sender.tab.id;

  switch (msg.type) {
    case 'analyzeImage':
      analyzeCached(String(msg.url || ''), senderIsLocal(sender), sender).then(sendResponse, () => sendResponse(null));
      return true;

    case 'getTopState':
      // An iframe only needs to know whether the page around it is themed: not its address
      // or other details (the frame may belong to another site, an ad network for example).
      chrome.tabs.sendMessage(tabId, { type: 'getStatus' }, { frameId: 0 })
        .then((r) => sendResponse(r ? { active: !!r.active } : null), () => sendResponse(null));
      return true;

    case 'topState':
      if (sender.frameId !== 0) return;
      setTabIcon(tabId, !!msg.active);
      setBadge(tabId, sender.tab.url);
      // Tell the iframes of this tab whether they are inside a themed page.
      chrome.tabs.sendMessage(tabId, { type: 'topState', active: !!msg.active }).catch(() => {});
      return;
  }
});

/* ------------------------------------------------------------- commands */

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  const settings = await DT.loadSettings();
  if (command === 'toggle-global') {
    await chrome.storage.local.set({ enabled: !settings.enabled });
    return;
  }
  if (command === 'toggle-site') {
    tab = tab || (await activeTab());
    const host = tab && DT.hostFromUrl(tab.url);
    if (!host) return;
    const status = await chrome.tabs.sendMessage(tab.id, { type: 'getStatus' }, { frameId: 0 }).catch(() => null);
    const isOn = status && status.ready ? status.active : DT.isEnabledFor(settings, host);
    await chrome.storage.local.set({ sites: DT.sitesWith(settings, host, isOn ? 'off' : 'on') });
  }
});

/* ------------------------------------------------- install / update */

chrome.runtime.onInstalled.addListener(async () => {
  // Inject into tabs that were open before installation, so no reload is needed.
  if (!chrome.scripting) return;
  const manifest = chrome.runtime.getManifest();
  const files = manifest.content_scripts[0].js;
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) {
    if (tab.discarded) continue;
    chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files }).catch(() => {});
  }
});
