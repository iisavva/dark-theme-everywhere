/*
 * Background worker: analyses cross-origin images, keeps the toolbar icon in sync,
 * relays the top page state to iframes and handles keyboard shortcuts.
 */
if (typeof importScripts === 'function' && typeof DT === 'undefined') importScripts('shared.js');

/* ------------------------------------------------------- image analysis */

const statsCache = new Map();
const MAX_BYTES = 8 * 1024 * 1024;

async function analyzeRemote(url) {
  const res = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
  if (!res.ok) return null;
  const type = (res.headers.get('content-type') || '').toLowerCase();
  const blob = await res.blob();
  if (blob.size > MAX_BYTES) return null;

  const svgByName = /\.svgz?(?:[?#]|$)/i.test(url) && (!type || type.includes('octet-stream') || type.includes('xml'));
  if (type.includes('svg') || svgByName) {
    // SVG cannot be rasterised in a worker; the content script draws it.
    if (blob.size > 1024 * 1024) return null;
    const text = await blob.text();
    return /<svg[\s>]/i.test(text) ? { svg: text } : null;
  }
  if (type && !type.startsWith('image/') && !type.includes('octet-stream')) return null;

  const bmp = await createImageBitmap(blob);
  const size = DT.sampleSize(bmp.width, bmp.height);
  const canvas = new OffscreenCanvas(size.w, size.h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, size.w, size.h);
  if (bmp.close) bmp.close();
  // Only statistics leave the worker, never the image itself.
  return DT.imageStats(ctx.getImageData(0, 0, size.w, size.h).data, size.w * size.h);
}

function analyzeCached(url) {
  if (!/^https?:/i.test(url)) return Promise.resolve(null);
  if (statsCache.has(url)) return statsCache.get(url);
  const p = analyzeRemote(url).catch(() => null);
  if (statsCache.size > 1000) statsCache.delete(statsCache.keys().next().value);
  statsCache.set(url, p);
  return p;
}

/* ----------------------------------------------------------------- icon */

function iconSet(on) {
  const s = on ? 'on' : 'off';
  return { 16: `/icons/${s}-16.png`, 32: `/icons/${s}-32.png`, 48: `/icons/${s}-48.png` };
}

function setTabIcon(tabId, on) {
  chrome.action.setIcon({ tabId, path: iconSet(on) }).catch(() => {});
  chrome.action.setTitle({ tabId, title: on ? 'Тёмная тема: включена' : 'Тёмная тема: выключена' }).catch(() => {});
}

/* ------------------------------------------------------------- messages */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !sender.tab) return;
  const tabId = sender.tab.id;

  switch (msg.type) {
    case 'analyzeImage':
      analyzeCached(String(msg.url || '')).then(sendResponse, () => sendResponse(null));
      return true;

    case 'getTopState':
      chrome.tabs.sendMessage(tabId, { type: 'getStatus' }, { frameId: 0 })
        .then((r) => sendResponse(r || null), () => sendResponse(null));
      return true;

    case 'topState':
      if (sender.frameId !== 0) return;
      setTabIcon(tabId, !!msg.active);
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
