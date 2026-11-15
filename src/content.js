/*
 * Content script: applies the dark theme to the page.
 *
 * How it works
 *  - The whole page is inverted with a CSS filter on <html> (invert + hue-rotate keeps hues close
 *    to the original). This works on any site, including ones with inline styles and canvases.
 *  - Photos, videos and other media are inverted back, so they look as in the original.
 *  - Images are analysed (transparency, brightness, colourfulness). A transparent dark logo would
 *    disappear on a dark background, so it is left inverted (becomes light). A white logo that sat
 *    on a dark header (the header becomes light) is inverted as well. The decision compares the
 *    contrast of both variants against the real background behind the image.
 *  - Light pictures with dark text (schemes, screenshots) can optionally be inverted too.
 *  - Sites that are already dark are detected and left alone.
 *  - In iframes only the media handling runs: the parent page's filter already covers the frame.
 */
(() => {
  'use strict';

  if (!(document instanceof HTMLDocument)) return;
  // A copy may already run here (the extension was reloaded and injected again).
  const previous = window.__darkThemeEverywhere;
  if (previous && previous.alive && previous.alive()) return;

  const D = globalThis.DT;
  const KEEP = 'data-dt-k'; // element shown in original colours (inverted back)
  const FLIP = 'data-dt-f'; // image shown inverted (dark logo -> light)
  const COLOR = 'data-dt-c'; // colour swatch or drawing surface shown in its real colours
  const BOARD = 'data-dt-b'; // drawing surface that gets the page's original background behind it
  const STYLE_ID = 'dark-theme-everywhere-style';
  const INV = 'invert(1) hue-rotate(180deg)';
  const isTop = window === window.top;
  const host = isTop ? D.hostFromUrl(location.href) : null;

  let settings = null;
  let mode = null;          // null | 'full' (top page) | 'images' (iframe)
  let nativeDark = false;   // the site is dark by itself
  let topActive = false;    // iframe: the top page is themed
  let rootLum = 1;          // luminance of the original page background
  let rootBg = '#fff';      // original page background colour (canvas)
  let rootBgChanged = false;
  let styleEl = null;
  let observer = null;
  let themeObserver = null;
  let gen = 0;
  let dead = false;
  let seen = new WeakMap();
  let shadowSeen = new WeakSet();
  const shadowStyles = new Set();
  const statsCache = new Map();

  // Remove a style left by a previous (reloaded) copy of the extension.
  document.querySelectorAll('#' + STYLE_ID).forEach((el) => el.remove());

  const alive = () => {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  };
  const send = (msg) => {
    try { return chrome.runtime.sendMessage(msg).catch(() => null); } catch (e) { return Promise.resolve(null); }
  };

  /* ------------------------------------------------------------------ CSS */

  // Rounded to 5 % steps: the filter is visible to the page, and exact slider values would make
  // users easier to tell apart (fingerprinting). The sliders use the same step.
  const pct = (v, def) => ((Math.round((Number.isFinite(+v) ? +v : def) / 5) * 5) / 100).toFixed(2);

  function buildCSS(full) {
    const s = settings;
    const F = `${INV} brightness(${pct(s.brightness, 100)}) contrast(${pct(s.contrast, 85)}) ` +
      `sepia(${pct(s.sepia, 0)}) grayscale(${pct(s.grayscale, 0)})`;
    const K = `brightness(${pct(s.imageBrightness, 90)}) ${INV}`;
    const media = ['img', 'input[type="image"]', 'video', 'canvas', 'embed', 'object'];
    const r = [];
    if (full) {
      // The canvas outside <html> is not filtered, so the page background is set on <html>
      // (taken from the site's <html>/<body>). Not !important: the site's own <html> rule wins.
      r.push(`html { background-color: ${rootBg}; }`);
      r.push(`html { filter: ${F} !important; }`);
      // Top-layer elements are painted outside <html>, so they need the filter themselves.
      // One selector per rule: an unknown selector must not drop the others.
      r.push(`:modal { filter: ${F} !important; }`);
      r.push(`:popover-open { filter: ${F} !important; }`);
      r.push(`:fullscreen:not(video):not(img):not(canvas) { filter: ${F} !important; }`);
    }
    r.push(`${media.map((m) => m + `:not([${FLIP}])`).join(', ')}, [${KEEP}] { filter: ${K} !important; }`);
    // Colour swatches and drawing surfaces: original colours, without the photo dimming.
    r.push(`[${COLOR}], input[type="color"] { filter: ${INV} !important; }`);
    r.push(`[${BOARD}] { background-color: ${rootBg} !important; }`);
    r.push(`[${FLIP}] { filter: none !important; }`);
    const restored = [`[${KEEP}]`, `[${COLOR}]`];
    const inner = media.concat(restored, `[${FLIP}]`, 'input[type="color"]');
    r.push(`${restored.flatMap((a) => inner.map((m) => `${a} ${m}`)).join(', ')} { filter: none !important; }`);
    if (full) r.push('video:fullscreen, img:fullscreen, canvas:fullscreen { filter: none !important; }');
    return r.join('\n');
  }

  function ensureStyle() {
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = STYLE_ID;
    }
    if (!styleEl.isConnected) {
      const parent = document.documentElement;
      if (parent) parent.insertBefore(styleEl, parent.firstChild);
    }
  }

  /* ----------------------------------------------------------- mode/state */

  function computeMode() {
    if (!settings) return null;
    if (!isTop) return topActive ? 'images' : null;
    if (!host || !D.isEnabledFor(settings, host)) return null;
    const ov = D.findOverride(settings, host);
    const forced = !!(ov && ov.value);
    if (settings.detectDarkSites && nativeDark && !forced) return null;
    return 'full';
  }

  function update(forceRescan) {
    if (dead) return;
    const next = computeMode();
    const changed = next !== mode;
    mode = next;
    if (!mode) {
      if (styleEl) styleEl.remove();
      stopObserving();
    } else {
      ensureStyle();
      const css = buildCSS(mode === 'full');
      if (styleEl.textContent !== css) styleEl.textContent = css;
      const shadowCss = buildCSS(false);
      shadowStyles.forEach((st) => { if (st.textContent !== shadowCss) st.textContent = shadowCss; });
      startObserving();
      if (changed || forceRescan) fullScan();
    }
    if (isTop) {
      updateThemeObserver();
      if (changed) send({ type: 'topState', active: mode === 'full' });
    }
  }

  function resetMarks() {
    gen++;
    seen = new WeakMap();
    paletteSeen = false;
    boardFound = false;
    const attrs = [KEEP, FLIP, COLOR, BOARD];
    const sel = attrs.map((a) => `[${a}]`).join(', ');
    const clear = (el) => attrs.forEach((a) => el.removeAttribute(a));
    document.querySelectorAll(sel).forEach(clear);
    shadowStyles.forEach((st) => {
      const root = st.getRootNode();
      if (root && root.querySelectorAll) root.querySelectorAll(sel).forEach(clear);
    });
  }

  /* -------------------------------------------------------- colour helpers */

  let colorCtx = null;
  function parseColor(str) {
    if (!str || str === 'transparent') return null;
    let m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(str);
    if (m) {
      let a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      return { r: +m[1], g: +m[2], b: +m[3], a };
    }
    // Modern colour syntaxes (oklch(), color(), …): let canvas convert them.
    try {
      if (!colorCtx) {
        const c = document.createElement('canvas');
        c.width = c.height = 1;
        colorCtx = c.getContext('2d', { willReadFrequently: true });
      }
      colorCtx.clearRect(0, 0, 1, 1);
      colorCtx.fillStyle = '#000';
      colorCtx.fillStyle = str;
      colorCtx.fillRect(0, 0, 1, 1);
      const d = colorCtx.getImageData(0, 0, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
    } catch (e) {
      return null;
    }
  }

  const luminance = (c) => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;

  function gradientColor(bg) {
    const m = /(rgba?\([^)]*\))/i.exec(bg);
    if (!m) return null;
    const c = parseColor(m[1]);
    return c && c.a >= 0.6 ? c : null;
  }

  const parentOf = (n) => n.parentElement || (n.getRootNode && n.getRootNode().host) || null;

  /** Luminance of the original background behind an element, or null if unknown (a picture). */
  function backdropLum(el) {
    for (let n = el; n; n = parentOf(n)) {
      if (n === document.documentElement) return rootLum;
      const cs = getComputedStyle(n);
      const c = parseColor(cs.backgroundColor);
      if (c && c.a >= 0.6) return luminance(c);
      if (n !== el) {
        const bi = cs.backgroundImage;
        if (bi && bi !== 'none') {
          const g = gradientColor(bi);
          if (g) return luminance(g);
          if (bi.includes('url(')) return null;
        }
      }
    }
    return rootLum;
  }

  function insideKeep(el) {
    for (let n = parentOf(el); n; n = parentOf(n)) if (n.hasAttribute && n.hasAttribute(KEEP)) return true;
    return false;
  }

  function hasVisibleText(el) {
    let text = false;
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && n.nodeValue.trim()) { text = true; break; }
    }
    if (!text) return false;
    const cs = getComputedStyle(el);
    if (parseFloat(cs.fontSize) < 2) return false;
    if (Math.abs(parseFloat(cs.textIndent)) > 500) return false;
    const c = parseColor(cs.color);
    if (c && c.a < 0.1) return false;
    return true;
  }

  /* ------------------------------------------------------ image analysis */

  let sampleCtx = null;
  function sample(source, w, h) {
    const size = D.sampleSize(w, h);
    if (!sampleCtx) {
      const c = document.createElement('canvas');
      sampleCtx = c.getContext('2d', { willReadFrequently: true });
    }
    const cv = sampleCtx.canvas;
    cv.width = size.w;
    cv.height = size.h;
    sampleCtx.clearRect(0, 0, size.w, size.h);
    sampleCtx.drawImage(source, 0, 0, size.w, size.h);
    return D.imageStats(sampleCtx.getImageData(0, 0, size.w, size.h).data, size.w * size.h);
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      const t = setTimeout(() => reject(new Error('timeout')), 10000);
      im.onload = () => { clearTimeout(t); resolve(im); };
      im.onerror = () => { clearTimeout(t); reject(new Error('load')); };
      im.src = src;
    });
  }

  function sameOrigin(src) {
    try { return new URL(src, location.href).origin === location.origin && location.origin !== 'null'; } catch (e) { return false; }
  }

  async function loadStats(src, pageLoaded) {
    if (/^(data|blob):/i.test(src) || sameOrigin(src)) {
      const im = await loadImage(src);
      return sample(im, im.naturalWidth || 64, im.naturalHeight || 64);
    }
    // Cross-origin: the background worker downloads and analyses the picture. It is not bound by
    // the page's network restrictions, so first make sure the page itself is allowed to load the
    // picture (the browser blocks pages from the local network, for example). Otherwise a page could
    // use the extension to probe addresses such as 192.168.1.1.nip.io that it cannot reach itself.
    if (!pageLoaded) await loadImage(src);
    const r = await send({ type: 'analyzeImage', url: src });
    if (!r) return null;
    if (r.svg) {
      const im = await loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(r.svg));
      return sample(im, im.naturalWidth || 64, im.naturalHeight || 64);
    }
    return r;
  }

  function getStats(src, img) {
    if (statsCache.has(src)) return statsCache.get(src);
    let p = null;
    // Pixels of the page's own <img> are read only for same-origin pictures. A cross-origin one was
    // loaded with the user's cookies; in browsers where an extension may read it (Firefox), the
    // decision below would leak a private picture to the page. Those go through the background
    // worker, which downloads the picture again without cookies.
    const readable = /^(data|blob):/i.test(src) || sameOrigin(src);
    if (readable && img && img.complete && (img.naturalWidth || /\.svg/i.test(src))) {
      try {
        p = Promise.resolve(sample(img, img.naturalWidth || 64, img.naturalHeight || 64));
      } catch (e) {
        p = null; // tainted canvas – fall back to loading
      }
    }
    // A complete <img> with pixels was loaded by the page itself.
    const pageLoaded = !!(img && img.complete && img.naturalWidth);
    if (!p) p = loadStats(src, pageLoaded).catch(() => null);
    if (statsCache.size > 800) statsCache.delete(statsCache.keys().next().value);
    statsCache.set(src, p);
    return p;
  }

  /**
   * Returns 'keep' (show original colours) or 'flip' (show inverted).
   * `kind` is 'img' (default keep) or 'bg' (CSS background, default flip).
   */
  function decide(st, el, kind) {
    const def = kind === 'img' ? 'keep' : 'flip';
    if (!st || !st.opaque) return def;
    if (insideKeep(el)) return 'keep';

    const opaque = st.transparent < 0.1;
    if (opaque) {
      if (st.doc && settings.invertDocImages) return 'flip';
      if (kind === 'bg') {
        if (el === document.body) return 'flip';
        const text = (el.textContent || '').trim().length;
        if (text > 600) return 'flip'; // a texture behind a lot of content
      }
      return 'keep';
    }

    if (st.opaque < 6) return def;
    if (kind === 'bg' && hasVisibleText(el)) return 'flip';
    // The element's own background is filtered together with the picture,
    // so the designed combination stays readable either way.
    const own = parseColor(getComputedStyle(el).backgroundColor);
    if (own && own.a >= 0.6) return def;

    const behind = backdropLum(parentOf(el));
    if (behind === null) return def;
    const finalBg = 1 - behind; // what the background looks like after inversion
    const keepC = Math.abs(st.lum - finalBg);
    const flipC = Math.abs(1 - st.lum - finalBg);
    // A picture that blends into its original background (white text on a white page) must not
    // become readable in the dark theme: otherwise anyone who can post a picture (a forum, comments)
    // could show dark-theme users content that moderators never see. Keep it as hidden as it was.
    const blends = Math.abs(st.lum - behind) < 0.12 && (behind > 0.5 ? st.dark < 0.03 : st.light < 0.03);
    if (blends) return keepC <= flipC ? 'keep' : 'flip';
    const margin = st.colorful > 0.45 ? 0.3 : 0.1;
    if (flipC > keepC + margin) return 'flip';
    if (keepC > flipC + margin) return 'keep';
    return st.colorful > 0.45 ? 'keep' : def;
  }

  function processImg(img) {
    if (!settings.smartImages) return;
    const src = img.currentSrc || img.src;
    if (!src || !img.complete) return;
    if (!img.naturalWidth && !/\.svg|^data:image\/svg/i.test(src)) return;
    if (seen.get(img) === src) return;
    seen.set(img, src);
    const myGen = gen;
    getStats(src, img).then((st) => {
      if (myGen !== gen || !mode || seen.get(img) !== src) return;
      if (decide(st, img, 'img') === 'flip') img.setAttribute(FLIP, '');
      else img.removeAttribute(FLIP);
    });
  }

  const URL_RE = /url\(\s*(['"]?)(.*?)\1\s*\)/i;

  function processBg(el) {
    if (el === document.documentElement || el instanceof SVGElement) return;
    const bi = getComputedStyle(el).backgroundImage;
    const m = bi && bi !== 'none' ? URL_RE.exec(bi) : null;
    const url = m ? m[2] : null;
    const prev = seen.get(el);
    if (!url) {
      if (prev) { seen.delete(el); el.removeAttribute(KEEP); }
      return;
    }
    if (prev === url) return;
    seen.set(el, url);
    const myGen = gen;
    getStats(url, null).then((st) => {
      if (myGen !== gen || !mode || seen.get(el) !== url) return;
      if (decide(st, el, 'bg') === 'keep') el.setAttribute(KEEP, '');
      else el.removeAttribute(KEEP);
    });
  }

  /* ------------------------------------------------ colour swatches / boards */
  /*
   * A colour palette (brush colours on an online whiteboard, colour choice in a shop) must show the
   * real colours: inverted, a black swatch looks white and the user picks the wrong colour.
   * A palette is a group of at least 4 small clickable elements of similar size, without text,
   * filled with at least 3 different colours. Its swatches are shown in original colours.
   *
   * Pages with such a palette and a large drawing surface (a canvas or an SVG over a third of the
   * window) are editors: there the drawing surface is shown in original colours too, on the
   * page's original background, so a stroke looks exactly like the colour chosen for it. The
   * editor UI around it stays dark. Single round colour buttons (the "current colour" indicator)
   * also keep their colour there.
   */

  let paletteSeen = false;
  let boardFound = false;   // a large canvas is the bottom layer of the page (a whiteboard)
  let swatchMemo = new Map(); // per queue run: element -> swatch info | null
  let editorCheck = { at: -Infinity, surfaces: [] };

  function interactive(el) {
    for (let n = el, i = 0; n && n.nodeType === 1 && i < 3; n = n.parentElement, i++) {
      const t = n.localName;
      if (t === 'button' || t === 'a' || t === 'label' || t === 'input' || t === 'select') return true;
      const role = n.getAttribute('role');
      if (role && /^(button|radio|option|menuitem|menuitemradio|checkbox|gridcell|switch|tab)$/.test(role)) return true;
      if (getComputedStyle(n).cursor === 'pointer') return true;
    }
    return false;
  }

  /** Colour key and geometry of a swatch-like element, or null. */
  function swatchInfo(el) {
    if (swatchMemo.has(el)) return swatchMemo.get(el);
    let info = null;
    try { info = computeSwatch(el); } catch (e) { info = null; }
    swatchMemo.set(el, info);
    return info;
  }

  function computeSwatch(el) {
    if (el.childElementCount > 2 || SKIP.has(el.localName)) return null;
    if (el === document.body || el === document.documentElement) return null;
    let key = null;
    let round = false;
    let radius = 0;
    if (el.localName === 'svg') {
      const shape = el.querySelector('circle, rect, ellipse, path');
      if (!shape) return null;
      const c = parseColor(getComputedStyle(shape).fill);
      if (!c || c.a < 0.9) return null;
      key = `${c.r},${c.g},${c.b}`;
      round = shape.localName === 'circle' || shape.localName === 'ellipse';
    } else if (el instanceof SVGElement || el.localName === 'img' || el.localName === 'canvas' || el.localName === 'video') {
      return null;
    } else {
      const cs = getComputedStyle(el);
      const c = parseColor(cs.backgroundColor);
      const bi = cs.backgroundImage || '';
      if (c && c.a >= 0.9) key = `${c.r},${c.g},${c.b}`;
      else if (/gradient\(/.test(bi) && (bi.match(/rgba?\(/g) || []).length >= 4) key = 'gradient';
      else return null;
      radius = parseFloat(cs.borderTopLeftRadius) || 0;
    }
    if ((el.textContent || '').trim()) return null;
    const r = el.getBoundingClientRect();
    // From 2 px: a brush slot shows its colour as a dot as small as the brush (Holst).
    // Palettes (groups) use swatches of 8 px and more, see checkPalette.
    if (r.width < 2 || r.height < 2 || r.width > 64 || r.height > 64) return null;
    if (Math.max(r.width, r.height) / Math.min(r.width, r.height) > 2) return null;
    if (!round) round = radius >= Math.min(r.width, r.height) * 0.35;
    return { key, w: r.width, h: r.height, round };
  }

  /** Looks for a palette around a swatch candidate (up to 3 levels up) and marks it. */
  function checkPalette(el) {
    for (let a = el.parentElement, lvl = 0; a && lvl < 3 && a !== document.body; a = a.parentElement, lvl++) {
      const all = a.querySelectorAll('*');
      if (all.length > 400) return false;
      const items = [];
      for (const n of all) {
        let s = swatchInfo(n);
        if (s && (s.w < 8 || s.h < 8)) s = null;
        // A swatch inside another swatch (a ring around a dot) counts once.
        if (s && !(items.length && items[items.length - 1][0].contains(n))) items.push([n, s]);
      }
      if (items.length < 4) continue;
      const sizes = items.map(([, s]) => s.w).sort((x, y) => x - y);
      const median = sizes[sizes.length >> 1];
      const same = items.filter(([, s]) => Math.abs(s.w - median) <= median * 0.35);
      if (same.length < 4) continue;
      if (new Set(same.map(([, s]) => s.key)).size < 3) continue;
      if (same.filter(([n]) => interactive(n)).length < same.length / 2) continue;
      for (const [n] of same) n.setAttribute(COLOR, '');
      if (!paletteSeen) {
        paletteSeen = true;
        markSurfaces();
        // Elements checked before the palette was found (the current colour button) get
        // another look now that the page is known to be an editor.
        fullScan();
      }
      return true;
    }
    return false;
  }

  /** Large canvases and SVGs: the drawing surface of an editor. */
  function findSurfaces() {
    const now = performance.now();
    if (now - editorCheck.at < 1500) return editorCheck.surfaces;
    const min = innerWidth * innerHeight * 0.33;
    const surfaces = [];
    for (const el of document.querySelectorAll('canvas, svg')) {
      if (el.localName === 'svg' && el.ownerSVGElement) continue; // nested svg
      const r = el.getBoundingClientRect();
      if (r.width * r.height >= min) surfaces.push(el);
      if (surfaces.length > 20) break;
    }
    editorCheck = { at: now, surfaces };
    return surfaces;
  }

  /*
   * A canvas is always shown in original colours, so a large transparent canvas also needs the
   * page's original background behind it: otherwise black strokes on a whiteboard land on the
   * darkened page and disappear. This does not need a palette. A large SVG is treated as a
   * drawing surface only on a page with a palette (otherwise it is an illustration).
   */
  function markSurfaces() {
    if (mode !== 'full') return;
    const surfaces = findSurfaces().filter((s) => s.localName === 'canvas' || paletteSeen);
    for (const s of surfaces) {
      s.setAttribute(COLOR, '');
      const r = s.getBoundingClientRect();
      const stack = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const at = stack.indexOf(s);
      // The background goes only behind a surface that is the bottom layer: everything under it
      // is its own containers. A canvas laid over the page content (a decorative effect) or an
      // upper layer of a layered board must stay transparent. If hit testing does not see the
      // surface (pointer-events: none, still laying out), nothing is changed.
      const bottom = at >= 0 && stack.slice(at + 1).every((n) => n.contains(s)) && !textUnder(s, r);
      // Once marked, the surface has the background from our own rule: do not mistake it for
      // the site's.
      const ownBg = !s.hasAttribute(BOARD) && opaqueBg(s);
      if (bottom && !boardFound) {
        boardFound = true;
        // Colour dots checked before the board was found get another look.
        setTimeout(fullScan, 0);
      }
      if (bottom && !ownBg) s.setAttribute(BOARD, '');
      else if (at >= 0) s.removeAttribute(BOARD);
    }
  }

  /** Whether visible page text lies under the surface (then it is an overlay, not a board). */
  function textUnder(s, r) {
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    let checked = 0;
    for (let n = walker.nextNode(); n && checked < 40; n = walker.nextNode()) {
      if (!n.nodeValue.trim()) continue;
      const el = n.parentElement;
      if (!el || el.closest('script, style, noscript, template')) continue;
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      const x = b.left + Math.min(b.width, 40) / 2;
      const y = b.top + b.height / 2;
      if (x < r.left || x > r.right || y < r.top || y > r.bottom || x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
      checked++;
      const stack = document.elementsFromPoint(x, y);
      const si = stack.indexOf(s);
      const ti = stack.findIndex((e) => e === el || el.contains(e) || e.contains(el));
      if (si >= 0 && ti > si) return true;
    }
    return false;
  }

  /** A page with a drawing surface: a board canvas at the bottom, or a large SVG next to a palette. */
  function editorPage() {
    return boardFound || (paletteSeen && findSurfaces().length > 0);
  }

  function isLarge(el) {
    const r = el.getBoundingClientRect();
    return r.width * r.height >= innerWidth * innerHeight * 0.33;
  }

  function opaqueBg(el) {
    const c = parseColor(getComputedStyle(el).backgroundColor);
    return !!(c && c.a >= 0.9);
  }

  function processSwatch(el) {
    const s = swatchInfo(el);
    if (!s) {
      if (el.hasAttribute(COLOR) && !findSurfaces().includes(el)) el.removeAttribute(COLOR);
      return;
    }
    if (el.hasAttribute(COLOR)) return;
    if (checkPalette(el)) return;
    // On a page with a drawing surface a single round colour button (the current colour, a brush
    // slot) keeps its colour too.
    if (s.round && !el.childElementCount && editorPage() && interactive(el)) {
      el.setAttribute(COLOR, '');
    }
  }

  const SKIP = new Set(['script', 'style', 'link', 'meta', 'head', 'title', 'noscript', 'template', 'br', 'source', 'track', 'option']);

  function processElement(el) {
    if (!el.isConnected) return;
    if (el.shadowRoot) setupShadow(el.shadowRoot);
    const tag = el.localName;
    if (SKIP.has(tag)) return;
    if (tag === 'img' || (tag === 'input' && el.type === 'image')) { processImg(el); return; }
    if (!settings.smartImages) return;
    if (tag === 'canvas' || tag === 'svg') {
      if ((tag === 'canvas' || paletteSeen) && isLarge(el)) {
        editorCheck.at = -Infinity;
        markSurfaces();
        return;
      }
      if (tag === 'canvas') return;
    }
    if (!(el instanceof SVGElement) || tag === 'svg') processSwatch(el);
    processBg(el);
  }

  /* -------------------------------------------------------- work queue */

  const queue = new Set();
  let scheduled = false;
  const idle = window.requestIdleCallback
    ? (cb) => window.requestIdleCallback(cb, { timeout: 400 })
    : (cb) => setTimeout(() => cb({ timeRemaining: () => 10 }), 30);

  function enqueue(el) {
    queue.add(el);
    if (!scheduled) { scheduled = true; idle(runQueue); }
  }

  function runQueue(deadline) {
    scheduled = false;
    if (!mode) { queue.clear(); return; }
    swatchMemo = new Map(); // sizes and colours may have changed since the last run
    const start = performance.now();
    for (const el of queue) {
      queue.delete(el);
      try { processElement(el); } catch (e) { /* ignore single element */ }
      if (performance.now() - start > 15 && deadline.timeRemaining() < 2) break;
    }
    if (queue.size && !scheduled) { scheduled = true; idle(runQueue); }
  }

  function scanTree(root) {
    if (root.nodeType === 1) enqueue(root);
    if (root.querySelectorAll) root.querySelectorAll('*').forEach(enqueue);
  }

  function fullScan() {
    if (document.documentElement) scanTree(document.documentElement);
  }

  /* -------------------------------------------------- observers / events */

  const OBS_OPTS = { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'src', 'srcset'] };

  function onMutations(muts) {
    if (!alive()) { teardown(); return; }
    if (mode && styleEl && !styleEl.isConnected) ensureStyle();
    for (const m of muts) {
      if (m.type === 'childList') {
        for (const n of m.addedNodes) if (n.nodeType === 1 && n !== styleEl) scanTree(n);
      } else if (m.target.nodeType === 1) {
        enqueue(m.target);
        // A popup (a colour palette, for example) is often shown by changing a class or style on
        // its container: its contents only get a size then, so look at them again.
        const t = m.target;
        if (t.firstElementChild && t !== document.body && t !== document.documentElement &&
            t.getElementsByTagName('*').length <= 300) {
          t.querySelectorAll('*').forEach(enqueue);
        }
      }
    }
  }

  function onLoadCapture(e) {
    const t = e.target;
    if (mode && t && t.localName === 'img') processImg(t);
  }

  function startObserving() {
    if (observer) return;
    observer = new MutationObserver(onMutations);
    observer.observe(document, OBS_OPTS);
    document.addEventListener('load', onLoadCapture, true);
  }

  function stopObserving() {
    if (observer) { observer.disconnect(); observer = null; }
    document.removeEventListener('load', onLoadCapture, true);
    queue.clear();
    shadowStyles.forEach((st) => st.remove());
    shadowStyles.clear();
    shadowSeen = new WeakSet();
  }

  function setupShadow(sr) {
    if (shadowSeen.has(sr) || !observer) return;
    shadowSeen.add(sr);
    const st = document.createElement('style');
    st.textContent = buildCSS(false);
    sr.appendChild(st);
    shadowStyles.add(st);
    sr.addEventListener('load', onLoadCapture, true);
    observer.observe(sr, OBS_OPTS);
    sr.querySelectorAll('*').forEach(enqueue);
  }

  function teardown() {
    dead = true;
    stopObserving();
    if (themeObserver) { themeObserver.disconnect(); themeObserver = null; }
    if (styleEl) styleEl.remove();
    mode = null;
  }

  /* ------------------------------------------------ dark site detection */

  function detectNativeDark() {
    if (!isTop || !settings || !document.documentElement) return;
    const sheet = styleEl && styleEl.isConnected ? styleEl.sheet : null;
    if (sheet) sheet.disabled = true;
    let dark = false;
    try {
      const html = document.documentElement;
      const hcs = getComputedStyle(html);
      const hc = parseColor(hcs.backgroundColor);
      const scheme = hcs.colorScheme || '';
      const schemeDark = /dark/.test(scheme) &&
        (!/light/.test(scheme) || matchMedia('(prefers-color-scheme: dark)').matches);
      // A transparent <html> takes the <body> background for the whole canvas.
      const bc = document.body ? parseColor(getComputedStyle(document.body).backgroundColor) : null;
      const rootColor = hc && hc.a >= 0.6 ? hc : bc && bc.a >= 0.6 ? bc : null;
      rootLum = rootColor ? luminance(rootColor) : schemeDark ? 0.1 : 1;
      const css = rootColor ? `rgb(${rootColor.r}, ${rootColor.g}, ${rootColor.b})` : schemeDark ? '#121212' : '#fff';
      if (css !== rootBg) { rootBg = css; rootBgChanged = true; }

      if (!document.body) {
        dark = rootLum < 0.4;
      } else {
        const w = innerWidth, h = innerHeight;
        const points = [[w / 2, h / 2], [w / 2, h * 0.2], [w * 0.2, h * 0.6], [w * 0.8, h * 0.6], [w / 2, h * 0.85]];
        let darkVotes = 0, votes = 0;
        for (const [x, y] of points) {
          const stack = document.elementsFromPoint(x, y);
          let lum = rootLum;
          for (const el of stack) {
            if (el === html) break;
            if (el.localName === 'img' || el.localName === 'video' || el.localName === 'canvas') continue;
            const c = parseColor(getComputedStyle(el).backgroundColor);
            if (c && c.a >= 0.6) { lum = luminance(c); break; }
          }
          votes++;
          if (lum < 0.4) darkVotes++;
        }
        dark = votes > 0 && darkVotes > votes / 2;
      }
    } catch (e) {
      dark = nativeDark;
    } finally {
      if (sheet) sheet.disabled = false;
    }
    if (dark !== nativeDark) {
      nativeDark = dark;
      update(true);
    } else if (rootBgChanged) {
      update();
    }
    rootBgChanged = false;
  }

  let persistTimer = 0;
  // Storage is shared with normal windows and outlives "clear history": a private window must not
  // leave the sites visited in it there.
  const incognito = (() => {
    try { return !!(chrome.extension && chrome.extension.inIncognitoContext); } catch (e) { return false; }
  })();

  function persistNativeDark() {
    if (!host || incognito || !alive()) return;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(async () => {
      try {
        const { nativeDark: map = {} } = await chrome.storage.local.get({ nativeDark: {} });
        if (!!map[host] === nativeDark) return;
        if (nativeDark) map[host] = true; else delete map[host];
        const keys = Object.keys(map);
        if (keys.length > 500) delete map[keys[0]];
        await chrome.storage.local.set({ nativeDark: map });
      } catch (e) { /* ignore */ }
    }, 300);
  }

  let detectTimer = 0;
  function scheduleDetect() {
    clearTimeout(detectTimer);
    detectTimer = setTimeout(() => { detectNativeDark(); persistNativeDark(); }, 150);
  }

  function updateThemeObserver() {
    const want = settings && settings.detectDarkSites && host && D.isEnabledFor(settings, host);
    if (!want) {
      if (themeObserver) { themeObserver.disconnect(); themeObserver = null; }
      return;
    }
    if (themeObserver) return;
    // Sites switch their own theme by changing class/style/data-* on <html> or <body>.
    themeObserver = new MutationObserver(scheduleDetect);
    const opts = { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-mode', 'data-mode'] };
    themeObserver.observe(document.documentElement, opts);
    whenBody(() => themeObserver && themeObserver.observe(document.body, opts));
  }

  function whenBody(cb) {
    if (document.body) { cb(); return; }
    const mo = new MutationObserver(() => {
      if (document.body) { mo.disconnect(); cb(); }
    });
    mo.observe(document.documentElement || document, { childList: true, subtree: true });
  }

  /* ------------------------------------------------------------- startup */

  function listen() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !settings) return;
      let relevant = false, images = false;
      for (const k of Object.keys(changes)) {
        if (!(k in D.DEFAULTS)) continue;
        relevant = true;
        const v = changes[k].newValue;
        settings[k] = v === undefined ? D.DEFAULTS[k] : v;
        if (D.IMAGE_KEYS.includes(k)) images = true;
      }
      if (!relevant) return;
      if (images) resetMarks();
      update(images);
      if (isTop && settings.detectDarkSites) scheduleDetect();
    });

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg) return;
      if (msg.type === 'getStatus' && isTop) {
        sendResponse({ ready: !!settings, active: mode === 'full', nativeDark, host });
      } else if (msg.type === 'topState' && !isTop) {
        if (topActive !== !!msg.active) { topActive = !!msg.active; update(); }
      }
    });
  }

  async function init() {
    try {
      settings = await D.loadSettings({ nativeDark: {} });
    } catch (e) {
      return;
    }
    if (isTop) nativeDark = !!(host && settings.nativeDark && settings.nativeDark[host]);
    delete settings.nativeDark;
    listen();
    update();

    // Sizes decide what is a colour swatch or a drawing surface: look again when they change
    // (and when a page that was loaded in a hidden window or tab is shown).
    let resizeTimer = 0;
    const rescan = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (mode && !dead) { editorCheck.at = -Infinity; fullScan(); } }, 500);
    };
    window.addEventListener('resize', rescan);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) rescan(); });

    if (isTop) {
      whenBody(detectNativeDark);
      document.addEventListener('DOMContentLoaded', detectNativeDark, { once: true });
      window.addEventListener('load', () => {
        detectNativeDark();
        if (mode) fullScan(); // CSS loaded late may have added background pictures
        setTimeout(() => { detectNativeDark(); persistNativeDark(); }, 1500);
      }, { once: true });
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', scheduleDetect);
    } else {
      const r = await send({ type: 'getTopState' });
      if (r && topActive !== !!r.active) { topActive = !!r.active; update(); }
    }
  }

  if (previous && previous.teardown) {
    try { previous.teardown(); } catch (e) { /* orphaned copy */ }
  }
  window.__darkThemeEverywhere = { alive, teardown };
  init();
})();
