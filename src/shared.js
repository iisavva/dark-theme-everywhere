/*
 * Shared helpers: settings, per-site rules and image statistics.
 * Loaded by the content script, the background worker, the popup and the options page.
 */
(function (root) {
  'use strict';

  const DEFAULTS = {
    enabled: true,          // dark theme for all sites
    sites: {},              // per-site rules: { "example.com": true | false }
    brightness: 100,        // %
    contrast: 85,           // % (below 100 softens pure black / pure white)
    sepia: 0,               // %
    grayscale: 0,           // %
    imageBrightness: 90,    // % brightness of photos and pictures
    smartImages: true,      // analyse images: make dark logos/icons visible
    invertDocImages: false, // invert light pictures with dark text (schemes, screenshots)
    detectDarkSites: true   // do not touch sites that are already dark
  };

  const IMAGE_KEYS = ['smartImages', 'invertDocImages'];

  function normalizeHost(host) {
    return String(host || '')
      .trim()
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/:\d+$/, '')
      .replace(/^\*\./, '')
      .replace(/^www\./, '')
      .replace(/\.$/, '');
  }

  function hostFromUrl(url) {
    try {
      const u = new URL(url);
      if (u.protocol === 'file:') return 'file';
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return normalizeHost(u.hostname) || null;
    } catch (e) {
      return null;
    }
  }

  /** Finds the rule for a host or for one of its parent domains. */
  function findOverride(settings, host) {
    const sites = (settings && settings.sites) || {};
    let h = normalizeHost(host);
    while (h) {
      if (Object.prototype.hasOwnProperty.call(sites, h)) return { key: h, value: !!sites[h] };
      const dot = h.indexOf('.');
      if (dot < 0) break;
      h = h.slice(dot + 1);
    }
    return null;
  }

  function isEnabledFor(settings, host) {
    const o = findOverride(settings, host);
    return o ? o.value : !!settings.enabled;
  }

  /** Returns a copy of the site rules with the rule for `host` set: 'default' | 'on' | 'off'. */
  function sitesWith(settings, host, state) {
    const sites = Object.assign({}, settings.sites || {});
    const key = normalizeHost(host);
    delete sites[key];
    if (state === 'on') sites[key] = true;
    else if (state === 'off') sites[key] = false;
    return sites;
  }

  /*
   * Pages of video players that sites embed in an iframe. Such a frame is shown as on the site:
   * the dark theme of the page around it is cancelled for the whole frame.
   * host suffix -> path prefix ('' = any path)
   */
  const PLAYER_EMBEDS = [
    ['youtube.com', '/embed/'],
    ['youtube-nocookie.com', '/embed/'],
    ['player.vimeo.com', ''],
    ['rutube.ru', '/play/embed/'],
    ['rutube.ru', '/embed/'],
    ['vk.com', '/video_ext.php'],
    ['vk.ru', '/video_ext.php'],
    ['vkvideo.ru', '/video_ext.php'],
    ['ok.ru', '/videoembed/'],
    ['dzen.ru', '/embed/'],
    ['dailymotion.com', '/embed/'],
    ['geo.dailymotion.com', '/player'],
    ['player.twitch.tv', ''],
    ['clips.twitch.tv', '/embed'],
    ['kinescope.io', '/embed/'],
    ['fast.wistia.net', '/embed/'],
    ['loom.com', '/embed/'],
    ['streamable.com', '/e/'],
    ['coub.com', '/embed/'],
    ['player.bilibili.com', ''],
    ['facebook.com', '/plugins/video.php']
  ];

  function isPlayerEmbedUrl(url) {
    let u;
    try { u = new URL(url); } catch (e) { return false; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const h = u.hostname.toLowerCase().replace(/^www\./, '');
    return PLAYER_EMBEDS.some(([suffix, path]) =>
      (h === suffix || h.endsWith('.' + suffix)) && u.pathname.startsWith(path));
  }

  async function loadSettings(extra) {
    const s = await chrome.storage.local.get(Object.assign({}, DEFAULTS, extra || {}));
    if (!s.sites || typeof s.sites !== 'object') s.sites = {};
    return s;
  }

  /* ---------- image statistics ---------- */

  const SAMPLE = 96;

  function sampleSize(w, h) {
    w = w || SAMPLE;
    h = h || SAMPLE;
    const k = Math.min(1, SAMPLE / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
  }

  /**
   * Analyses RGBA pixels.
   *  transparent – share of (almost) transparent pixels
   *  lum         – mean luminance of visible pixels (0 black … 1 white)
   *  colorful    – share of saturated pixels
   *  doc         – looks like a light picture with dark text (scheme, screenshot): mostly white
   *                paper, and what is drawn on it is mostly grey or black. A colourful
   *                illustration on a white background is not a document.
   */
  function imageStats(data, count) {
    let transparent = 0, opaque = 0, sumL = 0, dark = 0, light = 0, colorful = 0, paper = 0, ink = 0, tinted = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 50) { transparent++; continue; }
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      const sat = (max - min) / 255;
      opaque++;
      sumL += L;
      if (L < 0.35) dark++;
      if (L < 0.6 && sat < 0.2) ink++; // grey or black strokes and text
      if (L > 0.75) light++;
      if (sat > 0.3) colorful++;
      if (L > 0.88 && sat < 0.12) paper++;
      else if (sat > 0.2) tinted++; // drawn in colour
    }
    const drawn = opaque - paper;
    const total = count || data.length / 4;
    const op = opaque || 1;
    return {
      transparent: transparent / total,
      opaque,
      lum: opaque ? sumL / opaque : 0.5,
      dark: dark / op,
      light: light / op,
      colorful: colorful / op,
      doc: opaque > 0 && paper / op > 0.55 && ink / op > 0.008 && colorful / op < 0.2 &&
        tinted / (drawn || 1) < 0.35
    };
  }

  root.DT = {
    DEFAULTS,
    IMAGE_KEYS,
    normalizeHost,
    hostFromUrl,
    findOverride,
    isEnabledFor,
    sitesWith,
    isPlayerEmbedUrl,
    loadSettings,
    sampleSize,
    imageStats
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
