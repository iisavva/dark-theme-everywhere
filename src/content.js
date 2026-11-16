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
  const PLAYER = 'data-dt-p'; // video player shown as on the site (video, controls, captions)
  const EXCL = 'data-dt-x';  // element left as on the site (picked by the user, or a site rule)
  const PICKER = 'data-dt-picker'; // the element picker's own overlay
  const STYLE_ID = 'dark-theme-everywhere-style';
  const INV = 'invert(1) hue-rotate(180deg)';
  /*
   * Canvases that draw page content rather than pictures, so they are themed with the page like
   * text instead of being shown in original colours: the cell grid of Google Sheets (one large
   * canvas, which would otherwise be taken for a drawing board and stay white). Charts and
   * pictures inserted into a sheet keep their colours.
   */
  const THEMED_CANVAS = '#waffle-grid-container canvas:not(.waffle-embedded-object-overlay *), ' +
    'canvas.kix-canvas-tile-content';
  // Google Docs draws its pages on canvases as well (canvas.kix-canvas-tile-content): dark pages.
  /*
   * Elements always shown as on the site: the slides of Google Slides and their thumbnails keep
   * their design (like presentation software in dark mode); the editor and speaker notes are dark.
   */
  const BUILTIN_ORIGINAL = ['#workspace #pages svg', '.punch-filmstrip-thumbnails'];
  // A PDF shown by the browser's built-in viewer: themed with the page (dark pages, light text).
  const PDF_EMBED = 'embed[type="application/pdf"], object[type="application/pdf"]';
  const isPdf = document.contentType === 'application/pdf';
  const isTop = window === window.top;
  const host = isTop ? D.hostFromUrl(location.href) : null;

  let settings = null;
  // null | 'full' (top page) | 'images' (iframe, filter engine) | 'frame' (iframe, dynamic engine)
  // | 'player' (player iframe, filter engine)
  let mode = null;
  let scheduleTimer = 0;
  let siteThemeOn = false;  // the site's own dark theme is switched on (YouTube, GitHub…)
  let exclSelector = '';    // user and built-in exclusions of this page, as one selector list
  let nativeDark = false;   // the site is dark by itself
  let topActive = false;    // iframe: the top page is themed
  // iframe: a video player embedded by the page (YouTube, Vimeo…, or a frame that is mostly video)
  let playerFrame = !isTop && D.isPlayerEmbedUrl(location.href);
  let rootLum = 1;          // luminance of the original page background
  let rootBg = '#fff';      // original page background colour (canvas)
  let rootBgChanged = false;
  const artBackdrops = new Map(); // backdrop colour of an SVG illustration -> attribute value
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

  function buildCSS(cssMode) {
    if (cssMode === 'player') {
      // A player iframe: the page around it inverts the whole frame, so the frame cancels that
      // for everything in it. Fullscreen elements are painted outside <html> and need it too.
      return [
        `html { filter: ${INV} !important; }`,
        `:fullscreen { filter: ${INV} !important; }`
      ].join('\n');
    }
    if (dynamic()) return buildDynamicCSS(cssMode);
    const full = cssMode === 'full';
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
    r.push(`${THEMED_CANVAS}, ${PDF_EMBED} { filter: none !important; }`);
    // Colour swatches and drawing surfaces: original colours, without the photo dimming.
    // (The attribute is doubled to outrank `canvas:not([data-dt-f])` above.)
    r.push(`[${COLOR}][${COLOR}], input[type="color"] { filter: ${INV} !important; }`);
    r.push(`[${BOARD}] { background-color: ${rootBg} !important; }`);
    // SVG illustrations shown in original colours on their original background (see processSvgArt).
    for (const [css, token] of artBackdrops) {
      r.push(`svg[${KEEP}="${token}"], [${EXCL}="${token}"] { background-color: ${css} !important; }`);
    }
    // Video players and excluded elements: original colours, not dimmed either.
    r.push(`[${PLAYER}][${PLAYER}], [${EXCL}][${EXCL}] { filter: ${INV} !important; }`);
    r.push(`[${PICKER}][${PICKER}] { filter: ${INV} !important; }`);
    r.push(`[${FLIP}] { filter: none !important; }`);
    const restored = [`[${KEEP}]`, `[${COLOR}]`, `[${PLAYER}]`, `[${EXCL}]`];
    const inner = media.concat(restored, `[${FLIP}]`, 'input[type="color"]');
    r.push(`${restored.flatMap((a) => inner.map((m) => `${a} ${m}`)).join(', ')} { filter: none !important; }`);
    if (full) {
      r.push('video:fullscreen, img:fullscreen, canvas:fullscreen { filter: none !important; }');
      // A fullscreen player is painted outside <html>, so it is not inverted to begin with.
      r.push(`[${PLAYER}][${PLAYER}]:fullscreen { filter: none !important; }`);
    }
    return r.join('\n');
  }

  /*
   * Dynamic engine (beta): the page is not inverted. Its colours are rewritten instead: every
   * light background, dark text or light border colour found on an element gets a dark-theme
   * version (see processDynamic), applied by an attribute that points to a rule below. Pictures,
   * videos and canvases stay as they are; dark logos and the Google Sheets/Docs canvas are
   * inverted on their own.
   */
  function buildDynamicCSS(cssMode) {
    const s = settings;
    const r = [];
    const k = pct(s.imageBrightness, 90);
    if (cssMode === 'full' || cssMode === 'frame') {
      const root = parseColor(rootBg);
      const bg = (root && mapBg(root)) || 'rgb(24, 26, 27)';
      r.push(`html { background-color: ${bg} !important; color-scheme: dark !important; }`);
      const extra = [];
      if (pct(s.brightness, 100) !== '1.00') extra.push(`brightness(${pct(s.brightness, 100)})`);
      if (pct(s.sepia, 0) !== '0.00') extra.push(`sepia(${pct(s.sepia, 0)})`);
      if (pct(s.grayscale, 0) !== '0.00') extra.push(`grayscale(${pct(s.grayscale, 0)})`);
      if (extra.length) r.push(`html { filter: ${extra.join(' ')} !important; }`);
    }
    if (k !== '1.00') r.push(`img:not([${FLIP}]), video { filter: brightness(${k}) !important; }`);
    r.push(`[${FLIP}], ${THEMED_CANVAS}, ${PDF_EMBED} { filter: ${INV} !important; }`);
    r.push(`[${BOARD}] { background-color: ${rootBg} !important; }`);
    for (const [css, token] of artBackdrops) {
      r.push(`svg[${KEEP}="${token}"], [${EXCL}="${token}"] { background-color: ${css} !important; }`);
    }
    for (const [kind, map] of Object.entries(dynMaps)) {
      const { attr, prop } = DYN[kind];
      for (const e of map.values()) r.push(`[${attr}="${e.i}"] { ${prop}: ${e.css} !important; }`);
    }
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

  const dynamic = () => !!settings && settings.engine === 'dynamic';
  const systemDark = () => { try { return matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { return false; } };
  const env = () => ({ now: new Date(), systemDark: systemDark() });

  function computeMode() {
    if (!settings) return null;
    if (!isTop) {
      if (!topActive) return null;
      // With the filter engine the page around inverts the frame; with the dynamic engine every
      // frame rewrites its own colours. A player frame is left as it is either way.
      if (playerFrame) return dynamic() ? null : 'player';
      return dynamic() ? 'frame' : 'images';
    }
    if (!host || !D.isEnabledFor(settings, host, env())) return null;
    if (siteThemeOn) return null; // the site shows its own dark theme
    const ov = D.findOverride(settings, host);
    const forced = !!(ov && ov.value);
    if (settings.detectDarkSites && nativeDark && !forced && !isPdf) return null;
    return 'full';
  }

  /** Re-evaluates the mode when the time schedule switches. */
  function armSchedule() {
    clearTimeout(scheduleTimer);
    const ms = isTop && settings ? D.msToScheduleChange(settings) : null;
    if (ms) scheduleTimer = setTimeout(() => { if (!dead) { applySiteTheme(); update(); } }, Math.min(ms, 0x7fffffff));
  }

  function update(forceRescan) {
    if (dead) return;
    armSchedule();
    const next = computeMode();
    const changed = next !== mode;
    mode = next;
    if (!mode) {
      if (styleEl) styleEl.remove();
      stopObserving();
    } else {
      ensureStyle();
      const css = buildCSS(mode);
      if (styleEl.textContent !== css) styleEl.textContent = css;
      const shadowCss = buildCSS(mode === 'player' ? 'player' : mode === 'full' ? 'images' : mode);
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
    dynMaps = { b: new Map(), t: new Map(), r: new Map(), g: new Map(), f: new Map(), s: new Map() };
    const attrs = [KEEP, FLIP, COLOR, BOARD, PLAYER, ...DYN_ATTRS];
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
    const b = backdrop(el);
    return b ? b.lum : null;
  }

  /** The original background behind an element: { lum, css }, or null if unknown (a picture). */
  function backdrop(el) {
    const rgb = (c) => ({ lum: luminance(c), css: `rgb(${c.r}, ${c.g}, ${c.b})` });
    for (let n = el; n; n = parentOf(n)) {
      if (n === document.documentElement) return { lum: rootLum, css: rootBg };
      const cs = getComputedStyle(n);
      const c = parseColor(cs.backgroundColor);
      if (c && c.a >= 0.6) return rgb(c);
      if (n !== el) {
        const bi = cs.backgroundImage;
        if (bi && bi !== 'none') {
          const g = gradientColor(bi);
          if (g) return rgb(g);
          if (bi.includes('url(')) return null;
        }
      }
    }
    return { lum: rootLum, css: rootBg };
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
    // What the background looks like in the dark theme: inverted by the filter engine; with the
    // dynamic engine light backgrounds get dark (see mapBg) and dark ones stay as they are.
    const finalBg = dynamic() ? (behind > 0.35 ? 0.07 + (1 - behind) * 0.42 : behind) : 1 - behind;
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
      const d = decide(st, el, 'bg');
      if (d === 'keep') markAttr(el, KEEP, '');
      else el.removeAttribute(KEEP);
      // Dynamic engine: the page is not inverted, so a dark transparent icon is inverted on its own
      // (only without text in it: inverting would turn the text dark).
      const inv = dynamic() && d === 'flip' && st && st.transparent >= 0.1 && !hasVisibleText(el);
      if (inv) el.setAttribute(FLIP, ''); else if (el.hasAttribute(FLIP)) el.removeAttribute(FLIP);
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
      for (const [n] of same) markAttr(n, COLOR, '');
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

  function isThemedCanvas(el) {
    try { return el.localName === 'canvas' && el.matches(THEMED_CANVAS); } catch (e) { return false; }
  }

  /** Large canvases and SVGs: the drawing surface of an editor. */
  function findSurfaces() {
    const now = performance.now();
    if (now - editorCheck.at < 1500) return editorCheck.surfaces;
    const min = innerWidth * innerHeight * 0.33;
    const surfaces = [];
    for (const el of document.querySelectorAll('canvas, svg')) {
      if (isThemedCanvas(el)) continue; // page content (a spreadsheet grid), not a drawing board
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
      markAttr(s, COLOR, '');
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

  /*
   * A board app may change its canvas (style, size) on every frame while the user pans or zooms.
   * Every change queues the canvas again; the surface check (hit testing, a walk over the page
   * text) then runs at most once a second, with one deferred run for the last change.
   */
  let surfaceTimer = 0;
  let surfaceAt = -Infinity;

  function surfacesSoon() {
    const wait = 1000 - (performance.now() - surfaceAt);
    if (wait <= 0) {
      surfaceAt = performance.now();
      editorCheck.at = -Infinity;
      markSurfaces();
      return;
    }
    if (!surfaceTimer) {
      surfaceTimer = setTimeout(() => { surfaceTimer = 0; if (!dead) surfacesSoon(); }, wait);
    }
  }

  /** Whether visible page text lies under the surface (then it is an overlay, not a board). */
  function textUnder(s, r) {
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    let checked = 0;
    let visited = 0;
    // Bounded: on a page with a huge amount of text only the first text nodes are looked at.
    for (let n = walker.nextNode(); n && checked < 40 && visited < 2000; n = walker.nextNode(), visited++) {
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
      if (el.hasAttribute(COLOR) && el.getAttribute(COLOR) !== 'backdrop' && !findSurfaces().includes(el)) {
        el.removeAttribute(COLOR);
      }
      return;
    }
    if (el.hasAttribute(COLOR)) return;
    if (checkPalette(el)) return;
    // On a page with a drawing surface a single round colour button (the current colour, a brush
    // slot) keeps its colour too.
    if (s.round && !el.childElementCount && editorPage() && interactive(el)) {
      markAttr(el, COLOR, '');
    }
  }

  /* ------------------------------------------------------------- video players */
  /*
   * A video is inverted back on its own, but its player is more than the <video>: controls,
   * progress bar, captions, title and preview overlays sit around and over it. Those were themed
   * with the page, so the player looked broken. The player container (the outermost ancestor of
   * about the video's size, a control bar below it included) is shown as on the site instead.
   * In an iframe that is mostly one video the whole frame is treated as a player.
   */
  const playerOf = new WeakMap(); // video -> marked container

  function processVideo(v) {
    const prev = playerOf.get(v);
    const r = v.getBoundingClientRect();
    let container = null;
    if (r.width >= 160 && r.height >= 90) {
      container = v;
      for (let a = v.parentElement, i = 0; a && i < 8; a = a.parentElement, i++) {
        if (a === document.body || a === document.documentElement) break;
        const b = a.getBoundingClientRect();
        if (b.width > r.width * 1.1 + 16 || b.height > r.height * 1.15 + 80) break;
        if ((a.textContent || '').trim().length > 500) break; // an article around the video
        container = a;
      }
    }
    if (prev && prev !== container) prev.removeAttribute(PLAYER);
    if (container) {
      markAttr(container, PLAYER, '');
      playerOf.set(v, container);
    } else {
      playerOf.delete(v);
    }
    if (!isTop && !playerFrame && innerWidth > 0 && r.width * r.height >= innerWidth * innerHeight * 0.5) {
      playerFrame = true;
      update(true);
    }
  }

  /*
   * The dimming backdrop of a modal window (a translucent black layer over the whole page) would
   * turn white when inverted and lighten the dark page instead of dimming it. Such a backdrop
   * keeps its original colour.
   */
  function processBackdrop(el) {
    const cs = getComputedStyle(el);
    const was = el.hasAttribute(COLOR) && el.getAttribute(COLOR) === 'backdrop';
    let is = false;
    if (cs.position === 'fixed' && !el.childElementCount && !(el.textContent || '').trim()) {
      const c = parseColor(cs.backgroundColor);
      const alpha = c ? c.a * effectiveOpacity(el) : 0;
      if (c && luminance(c) < 0.25 && alpha > 0.05 && alpha < 0.95) {
        const r = el.getBoundingClientRect();
        is = r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.9;
      }
    }
    if (is && !was) markAttr(el, COLOR, 'backdrop');
    else if (!is && was) el.removeAttribute(COLOR);
    return is;
  }

  /* ------------------------------------------------------- dynamic engine */
  /*
   * Colours are read from the computed style of every element and mapped to a dark theme:
   *  - backgrounds lighter than 35 % lightness get dark (hue kept, a little less saturated);
   *  - text darker than 62 % lightness gets light; borders lighter than 30 % get dark;
   *  - gradients get their colours mapped; dark fills and strokes of SVG icons get light.
   * Already dark backgrounds and light text are left alone, so mapping a mapped colour changes
   * nothing. Each new colour gets an index; the element gets an attribute with it, and the
   * stylesheet a rule for it (only numbers go into the rules).
   */
  const DYN = {
    b: { attr: 'data-dtb', prop: 'background-color' },
    t: { attr: 'data-dtt', prop: 'color' },
    r: { attr: 'data-dtr', prop: 'border-color' },
    g: { attr: 'data-dtg', prop: 'background-image' },
    f: { attr: 'data-dtf', prop: 'fill' },
    s: { attr: 'data-dts', prop: 'stroke' }
  };
  const DYN_ATTRS = Object.values(DYN).map((d) => d.attr);
  let dynMaps = { b: new Map(), t: new Map(), r: new Map(), g: new Map(), f: new Map(), s: new Map() };
  let dynDirty = false;
  const dynLast = new WeakMap(); // element -> time of the last rewrite

  function toHsl(c) {
    const r = c.r / 255, g = c.g / 255, b = c.b / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h /= 6;
    }
    return { h, s, l };
  }

  function fromHsl(h, s, l, a) {
    const hue = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    let r = l, g = l, b = l;
    if (s) {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue(p, q, h + 1 / 3); g = hue(p, q, h); b = hue(p, q, h - 1 / 3);
    }
    const n = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255);
    const alpha = Math.round(Math.max(0, Math.min(1, a)) * 1000) / 1000;
    return `rgba(${n(r)}, ${n(g)}, ${n(b)}, ${alpha})`;
  }

  function mapBg(c) {
    const { h, s, l } = toHsl(c);
    if (l <= 0.35) return null;
    return fromHsl(h, s * 0.8, 0.07 + (1 - l) * 0.42, c.a);
  }

  function mapText(c) {
    const { h, s, l } = toHsl(c);
    if (l >= 0.62) return null;
    // black -> 90 % lightness, mid grey -> about 67 %; the contrast setting (85 % by default)
    // spreads or narrows that around the middle.
    const contrast = Math.max(0.5, Math.min(1.8, (Number(settings.contrast) || 85) / 85));
    const l2 = 0.5 + (0.9 - l * 0.45 - 0.5) * contrast;
    return fromHsl(h, s * 0.9, Math.max(0.62, Math.min(0.97, l2)), c.a);
  }

  function mapBorder(c) {
    const { h, s, l } = toHsl(c);
    if (l <= 0.3) return null;
    return fromHsl(h, s * 0.8, 0.16 + (1 - l) * 0.35, c.a);
  }

  function dynIndex(kind, key, css) {
    const map = dynMaps[kind];
    let e = map.get(key);
    if (!e) {
      if (map.size >= 1500) return null;
      e = { i: map.size, css };
      map.set(key, e);
      dynDirty = true;
    }
    return e.i;
  }

  function setDyn(el, kind, index) {
    const attr = DYN[kind].attr;
    if (index === null || index === undefined) {
      if (el.hasAttribute(attr)) el.removeAttribute(attr);
    } else if (el.getAttribute(attr) !== String(index)) {
      el.setAttribute(attr, String(index));
    }
  }

  function clearDyn(el) {
    for (const a of DYN_ATTRS) if (el.hasAttribute(a)) el.removeAttribute(a);
  }

  /**
   * Sets a "shown as on the site" mark (KEEP, COLOR, PLAYER, EXCL). With the dynamic engine the
   * element and everything in it may already have rewritten colours: those are removed.
   */
  function markAttr(el, attr, value) {
    el.setAttribute(attr, value);
    if (dynamic()) {
      clearDyn(el);
      el.querySelectorAll(DYN_ATTRS.map((a) => `[${a}]`).join(', ')).forEach(clearDyn);
    }
  }

  /** Elements shown as on the site: their colours are not rewritten. */
  function keepsOriginal(el) {
    return !!(el.closest && el.closest(`[${COLOR}], [${PLAYER}], [${EXCL}], [${KEEP}], [${PICKER}]`));
  }

  const GRADIENT_SAFE = /^[a-z0-9\s(),.%#-]+$/i;

  function processDynamic(el) {
    if (!dynamic() || !mode || mode === 'player') return;
    if (keepsOriginal(el)) { clearDyn(el); return; }
    // Scripts that animate inline styles would make this run on every frame.
    const now = performance.now();
    const last = dynLast.get(el);
    if (last && now - last < 300) { laterSoon(el); return; }
    dynLast.set(el, now);
    // Read the site's own colours, not ours.
    clearDyn(el);
    const cs = getComputedStyle(el);
    const svgShape = el instanceof SVGElement && el.localName !== 'svg';
    if (svgShape) {
      const root = outerSvg(el);
      if (root && root.hasAttribute(KEEP)) return; // an illustration keeps its colours
      for (const [kind, value] of [['f', cs.fill], ['s', cs.stroke]]) {
        const c = /^rgba?\(/.test(value) ? parseColor(value) : null;
        const css = c && c.a > 0.05 ? mapText(c) : null;
        setDyn(el, kind, css ? dynIndex(kind, value, css) : null);
      }
      return;
    }
    if (el !== document.documentElement) {
      const bc = parseColor(cs.backgroundColor);
      const bcss = bc && bc.a > 0.02 ? mapBg(bc) : null;
      setDyn(el, 'b', bcss ? dynIndex('b', cs.backgroundColor, bcss) : null);
      const bi = cs.backgroundImage;
      let gIndex = null;
      if (bi && bi.includes('gradient(') && !bi.includes('url(')) {
        const mapped = bi.replace(/rgba?\([^)]*\)/g, (m) => {
          const c = parseColor(m);
          return (c && mapBg(c)) || m;
        });
        if (mapped !== bi && GRADIENT_SAFE.test(mapped)) gIndex = dynIndex('g', bi, mapped);
      }
      setDyn(el, 'g', gIndex);
    }
    const tc = parseColor(cs.color);
    const tcss = tc && tc.a > 0.05 ? mapText(tc) : null;
    setDyn(el, 't', tcss ? dynIndex('t', cs.color, tcss) : null);
    const hasBorder = ['Top', 'Right', 'Bottom', 'Left'].some((side) =>
      parseFloat(cs[`border${side}Width`]) > 0 && cs[`border${side}Style`] !== 'none');
    let rIndex = null;
    if (hasBorder) {
      const rc = parseColor(cs.borderTopColor);
      const rcss = rc && rc.a > 0.05 ? mapBorder(rc) : null;
      if (rcss) rIndex = dynIndex('r', cs.borderTopColor, rcss);
    }
    setDyn(el, 'r', rIndex);
  }

  const laterSet = new Set();
  let laterTimer = 0;
  function laterSoon(el) {
    laterSet.add(el);
    if (!laterTimer) {
      laterTimer = setTimeout(() => {
        laterTimer = 0;
        if (!dead && mode) laterSet.forEach(enqueue);
        laterSet.clear();
      }, 400);
    }
  }

  /** New colours were found: rebuild the stylesheet once per queue run. */
  function flushDynamic() {
    if (!dynDirty) return;
    dynDirty = false;
    update();
  }

  /* ------------------------------------------------------- site dark themes */
  /*
   * Sites with a dark theme of their own: it is switched on instead of inverting the page
   * (checked on the live sites). The attributes are put back when the theme is turned off.
   */
  const SITE_THEMES = [
    { hosts: ['youtube.com'], on: { attrs: { dark: '' } } },
    { hosts: ['github.com'], on: { attrs: { 'data-color-mode': 'dark', 'data-dark-theme': 'dark' } } },
    {
      hosts: ['wikipedia.org'],
      on: { add: ['skin-theme-clientpref-night'], remove: ['skin-theme-clientpref-day', 'skin-theme-clientpref-os'] }
    },
    {
      hosts: ['stackoverflow.com', 'stackexchange.com', 'superuser.com', 'serverfault.com', 'askubuntu.com',
        'mathoverflow.net'],
      body: true,
      on: { add: ['theme-dark'], remove: ['theme-light', 'theme-system'] }
    }
  ];

  const siteTheme = host ? SITE_THEMES.find((t) => t.hosts.some((h) => host === h || host.endsWith('.' + h))) : null;
  let siteThemeSaved = null; // what the attributes were before
  let siteThemeObserver = null;

  function wantSiteTheme() {
    return !!(isTop && siteTheme && settings && settings.useSiteThemes && D.isEnabledFor(settings, host, env()));
  }

  function siteThemeTarget() {
    return siteTheme.body ? document.body : document.documentElement;
  }

  function putSiteTheme(target) {
    const on = siteTheme.on;
    if (!siteThemeSaved) {
      siteThemeSaved = { attrs: {}, classes: target.className };
      for (const a of Object.keys(on.attrs || {})) siteThemeSaved.attrs[a] = target.getAttribute(a);
    }
    for (const [a, v] of Object.entries(on.attrs || {})) if (target.getAttribute(a) !== v) target.setAttribute(a, v);
    for (const c of on.remove || []) if (target.classList.contains(c)) target.classList.remove(c);
    for (const c of on.add || []) if (!target.classList.contains(c)) target.classList.add(c);
  }

  function applySiteTheme() {
    if (!siteTheme || !isTop) return;
    const want = wantSiteTheme();
    if (want) {
      const run = () => {
        const target = siteThemeTarget();
        if (!target) return;
        putSiteTheme(target);
        // The site's scripts may set their own theme again on load.
        if (!siteThemeObserver) {
          siteThemeObserver = new MutationObserver(() => { if (siteThemeOn) putSiteTheme(target); });
          siteThemeObserver.observe(target, { attributes: true, attributeFilter: ['class', ...Object.keys(siteTheme.on.attrs || {})] });
        }
      };
      if (siteTheme.body && !document.body) whenBody(run); else run();
      siteThemeOn = true;
    } else if (siteThemeOn) {
      siteThemeOn = false;
      if (siteThemeObserver) { siteThemeObserver.disconnect(); siteThemeObserver = null; }
      const target = siteThemeTarget();
      if (target && siteThemeSaved) {
        for (const [a, v] of Object.entries(siteThemeSaved.attrs)) {
          if (v === null) target.removeAttribute(a); else target.setAttribute(a, v);
        }
        for (const c of siteTheme.on.add || []) target.classList.remove(c);
        for (const c of siteTheme.on.remove || []) if ((' ' + siteThemeSaved.classes + ' ').includes(' ' + c + ' ')) target.classList.add(c);
      }
      siteThemeSaved = null;
    }
  }

  /* ------------------------------------------------------- excluded elements */
  /*
   * Elements the user picked (or a built-in rule names) are shown as on the site. Selectors come
   * from the extension's own storage and are only used to find elements; they are never put
   * into the stylesheet (the found elements get an attribute instead).
   */
  function validSelector(sel) {
    if (typeof sel !== 'string' || !sel || sel.length > 500 || /[{};<@\\\n]/.test(sel)) return false;
    try { document.createDocumentFragment().querySelector(sel); return true; } catch (e) { return false; }
  }

  function computeExclusions() {
    const list = isTop && host && settings ? D.exclusionsFor(settings, host).filter(validSelector) : [];
    return list.concat(BUILTIN_ORIGINAL).join(', ');
  }

  function processExclusion(el) {
    let match = false;
    try { match = !!exclSelector && el.matches(exclSelector); } catch (e) { match = false; }
    if (match) {
      // A transparent element shown as on the site would lie on the dark page; it gets the
      // site's original background behind it, so it looks exactly as on the site.
      let value = '';
      const ours = /^bg\d+$/.test(el.getAttribute(EXCL) || '');
      if (ours || !opaqueBg(el)) {
        const b = backdrop(parentOf(el));
        if (b) value = backdropToken(b.css) || '';
      }
      if (el.getAttribute(EXCL) !== value) markAttr(el, EXCL, value);
    } else if (el.hasAttribute(EXCL)) {
      el.removeAttribute(EXCL);
    }
    return match;
  }

  function refreshExclusions() {
    const next = computeExclusions();
    if (next === exclSelector) return false;
    exclSelector = next;
    document.querySelectorAll(`[${EXCL}]`).forEach((el) => el.removeAttribute(EXCL));
    return true;
  }

  /* ------------------------------------------------------- element picker */
  const PICK_TEXT = {
    en: 'Click an element to leave it as on the site · Esc to cancel',
    ru: 'Нажмите на элемент, чтобы оставить его как на сайте · Esc — отмена'
  };
  let picking = null;

  function cssPart(n) {
    let part = n.localName;
    const same = n.parentElement ? [...n.parentElement.children].filter((c) => c.localName === n.localName) : [];
    if (same.length > 1) part += `:nth-of-type(${same.indexOf(n) + 1})`;
    return part;
  }

  /** A short selector that finds this element (an id, or a path of tags). */
  function makeSelector(el) {
    const idOk = (n) => n.id && /^[A-Za-z][\w-]{0,80}$/.test(n.id) &&
      document.querySelectorAll('#' + CSS.escape(n.id)).length === 1;
    if (idOk(el)) return '#' + CSS.escape(el.id);
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (n !== el && idOk(n)) { parts.unshift('#' + CSS.escape(n.id)); break; }
      parts.unshift(cssPart(n));
      if (n === document.body) break;
    }
    const sel = parts.join(' > ');
    try { return document.querySelector(sel) === el ? sel : null; } catch (e) { return null; }
  }

  function stopPicker() {
    if (!picking) return;
    const p = picking;
    picking = null;
    p.box.remove();
    p.tip.remove();
    for (const [type, fn] of p.listeners) window.removeEventListener(type, fn, true);
  }

  function startPicker() {
    if (!isTop || picking || !document.body) return;
    const box = document.createElement('div');
    const tip = document.createElement('div');
    box.setAttribute(PICKER, '');
    tip.setAttribute(PICKER, '');
    box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #f5c84c;' +
      'background:rgba(245,200,76,.18);border-radius:3px;display:none;';
    tip.style.cssText = 'position:fixed;z-index:2147483647;left:50%;top:12px;transform:translateX(-50%);' +
      'background:#1e2128;color:#e6e8ec;font:13px/1.4 system-ui,sans-serif;padding:8px 12px;border-radius:8px;' +
      'box-shadow:0 2px 10px rgba(0,0,0,.4);pointer-events:none;';
    tip.textContent = PICK_TEXT[settings.language] || PICK_TEXT.en;
    document.documentElement.append(box, tip);
    let target = null;
    const swallow = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
    const listeners = [
      ['mousemove', (e) => {
        if (!e.isTrusted) return; // only the user's own mouse, not events made up by the page
        const el = e.target;
        if (!el || el.nodeType !== 1 || el.hasAttribute(PICKER)) return;
        target = el;
        const r = el.getBoundingClientRect();
        Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
      }],
      ['mousedown', swallow], ['mouseup', swallow], ['pointerdown', swallow], ['pointerup', swallow],
      ['click', async (e) => {
        swallow(e);
        if (!e.isTrusted) return; // the page cannot pick an element on the user's behalf
        const el = target;
        stopPicker();
        if (!el || el === document.documentElement || el === document.body) return;
        const sel = makeSelector(el);
        if (!sel || !validSelector(sel)) return;
        const fresh = await D.loadSettings();
        await chrome.storage.local.set({ exclusions: D.exclusionsWith(fresh, host, sel, true) });
      }],
      ['keydown', (e) => { if (e.isTrusted && e.key === 'Escape') { swallow(e); stopPicker(); } }]
    ];
    for (const [type, fn] of listeners) window.addEventListener(type, fn, true);
    picking = { box, tip, listeners };
  }

  const SKIP = new Set(['script', 'style', 'link', 'meta', 'head', 'title', 'noscript', 'template', 'br', 'source', 'track', 'option']);

  function processElement(el) {
    if (!el.isConnected) return;
    if (el.hasAttribute(PICKER)) return;
    if (el.shadowRoot) setupShadow(el.shadowRoot);
    const tag = el.localName;
    if (SKIP.has(tag)) return;
    processExclusion(el);
    if (tag === 'img' || (tag === 'input' && el.type === 'image')) { processImg(el); return; }
    if (tag === 'video') { processVideo(el); return; }
    if (processBackdrop(el)) return;
    if (tag === 'canvas') {
      if (settings.smartImages && isLarge(el)) surfacesSoon();
      return;
    }
    if (el instanceof SVGElement) {
      if (settings.smartImages) {
        if (tag === 'svg' && !el.ownerSVGElement) {
          if (paletteSeen && isLarge(el)) {
            surfacesSoon();
          } else {
            processSwatch(el);
            processSvgArt(el);
          }
        } else {
          // Shapes added to an SVG (an animation builds its frames this way): look at it again.
          const root = outerSvg(el);
          if (root) svgSoon(root);
        }
      }
      processDynamic(el);
      return;
    }
    if (settings.smartImages) {
      processSwatch(el);
      processBg(el);
    }
    processDynamic(el);
  }

  /* ------------------------------------------------------ inline SVG illustrations */
  /*
   * An inline <svg> is themed with the page like text: right for icons, which are drawn in one
   * colour (often the text colour). A colourful SVG illustration or animation (Lottie and the
   * like: achievements, mascots) would have its colours turned dark instead. Such an SVG is shown
   * in original colours, like a picture: at least 40 px, at least 8 painted shapes, at least
   * 5 different colours of which a quarter saturated (or 8 colours), or a raster <image> inside.
   * SVGs with text (charts, diagrams) keep the theme, so their labels stay readable.
   */
  const svgPending = new Set();
  let svgTimer = 0;

  function outerSvg(el) {
    let s = el.ownerSVGElement;
    while (s && s.ownerSVGElement) s = s.ownerSVGElement;
    return s || null;
  }

  function svgSoon(root) {
    svgPending.add(root);
    if (!svgTimer) {
      svgTimer = setTimeout(() => {
        svgTimer = 0;
        if (!dead && mode && mode !== 'player') svgPending.forEach(enqueue);
        svgPending.clear();
      }, 1000);
    }
  }

  function paintColor(value) {
    if (!value || !/^rgba?\(/.test(value)) return null; // none, url(#gradient), context-fill…
    const c = parseColor(value);
    return c && c.a >= 0.3 ? c : null;
  }

  /**
   * Whether an SVG is a colourful illustration: null if not, otherwise { backdrop } where backdrop
   * is the original background to show behind it ({ css }) or null when none is needed.
   */
  function isSvgArt(svg) {
    const r = svg.getBoundingClientRect();
    if (r.width < 40 || r.height < 40 || insideKeep(svg)) return null;
    if (svg.querySelectorAll('text, foreignObject').length > 2) return null;
    const under = backdrop(parentOf(svg));
    // A raster <image> is not analysed: it may hide content in its transparent parts, so it
    // always gets its original background.
    if (svg.querySelector('image')) return { backdrop: under };
    const shapes = svg.querySelectorAll('path, circle, rect, ellipse, polygon, polyline');
    if (shapes.length < 8) return null;
    const colors = new Set();
    const behind = under ? under.lum : null;
    let counted = 0, colorful = 0, blending = 0;
    for (let i = 0; i < shapes.length && counted < 200; i++) {
      const cs = getComputedStyle(shapes[i]);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (/^url\(/.test(cs.fill)) { counted++; colorful++; colors.add('gradient' + i % 4); continue; }
      const c = paintColor(cs.fill) || paintColor(cs.stroke);
      if (!c) continue;
      counted++;
      colors.add(`${c.r >> 5},${c.g >> 5},${c.b >> 5}`);
      const sat = (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)) / 255;
      if (sat > 0.3) colorful++;
      if (behind !== null && sat < 0.12 && Math.abs(luminance(c) - behind) < 0.12) blending++;
    }
    // Shapes that blend into the original background (white on white) must stay as hidden as they
    // were: shown in original colours on the dark page they would appear (content that moderators
    // of a site with user posts never saw). Mostly blending: the SVG keeps the theme, like the rest
    // of the page. A few such shapes (one large shape can hold a whole message): the illustration
    // gets its original background, so it looks exactly as on the original page.
    if (counted && blending / counted > 0.3) return null;
    if (!(counted >= 8 && colors.size >= 5 && (colorful / counted >= 0.25 || colors.size >= 8))) return null;
    return { backdrop: blending ? under : null };
  }

  /** Attribute value that gives an SVG illustration its original background (see buildCSS). */
  function backdropToken(css) {
    let token = artBackdrops.get(css);
    if (token) return token;
    if (artBackdrops.size >= 32) return null;
    token = 'bg' + artBackdrops.size;
    artBackdrops.set(css, token);
    update(); // adds the rule for the new colour
    return token;
  }

  function processSvgArt(svg) {
    const art = isSvgArt(svg);
    let value = null; // null: keep the theme
    if (art) {
      // Once given a background by our own rule, the SVG is not mistaken for one with its own.
      const ours = /^bg\d+$/.test(svg.getAttribute(KEEP) || '');
      if (!art.backdrop || (!ours && opaqueBg(svg))) value = ''; // nothing can show through the SVG
      else value = backdropToken(art.backdrop.css); // null if too many colours: keep the theme
    }
    if (value === null) {
      if (svg.hasAttribute(KEEP)) svg.removeAttribute(KEEP);
    } else if (svg.getAttribute(KEEP) !== value) {
      markAttr(svg, KEEP, value);
    }
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
    // A player frame is shown as on the site as a whole: nothing to analyse in it.
    if (!mode || mode === 'player') { queue.clear(); return; }
    swatchMemo = new Map(); // sizes and colours may have changed since the last run
    const start = performance.now();
    for (const el of queue) {
      queue.delete(el);
      try { processElement(el); } catch (e) { /* ignore single element */ }
      if (performance.now() - start > 15 && deadline.timeRemaining() < 2) break;
    }
    flushDynamic();
    if (queue.size && !scheduled) { scheduled = true; idle(runQueue); }
  }

  function scanTree(root) {
    if (root.nodeType === 1) enqueue(root);
    if (root.querySelectorAll) root.querySelectorAll('*').forEach(enqueue);
  }

  let lastScanArea = 0; // window area at the last full scan

  function fullScan() {
    lastScanArea = innerWidth * innerHeight;
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

  // A video often gets its real size only when its metadata has loaded.
  function onVideoMeta(e) {
    const t = e.target;
    if (mode && mode !== 'player' && t && t.localName === 'video') enqueue(t);
  }

  function startObserving() {
    if (observer) return;
    observer = new MutationObserver(onMutations);
    observer.observe(document, OBS_OPTS);
    document.addEventListener('load', onLoadCapture, true);
    document.addEventListener('loadedmetadata', onVideoMeta, true);
  }

  function stopObserving() {
    if (observer) { observer.disconnect(); observer = null; }
    document.removeEventListener('load', onLoadCapture, true);
    document.removeEventListener('loadedmetadata', onVideoMeta, true);
    queue.clear();
    shadowStyles.forEach((st) => st.remove());
    shadowStyles.clear();
    shadowSeen = new WeakSet();
  }

  function setupShadow(sr) {
    if (shadowSeen.has(sr) || !observer) return;
    shadowSeen.add(sr);
    const st = document.createElement('style');
    st.textContent = buildCSS(mode === 'player' ? 'player' : 'images');
    sr.appendChild(st);
    shadowStyles.add(st);
    sr.addEventListener('load', onLoadCapture, true);
    observer.observe(sr, OBS_OPTS);
    sr.querySelectorAll('*').forEach(enqueue);
  }

  function teardown() {
    dead = true;
    stopPicker();
    clearTimeout(scheduleTimer);
    stopObserving();
    if (themeObserver) { themeObserver.disconnect(); themeObserver = null; }
    if (styleEl) styleEl.remove();
    mode = null;
  }

  /* ------------------------------------------------ dark site detection */

  /*
   * Helpers of the dark site check. A modal window, its backdrop or a cookie banner lies over the
   * page: a black backdrop made translucent with `opacity` (Bootstrap) or a dark rgba layer must
   * not make a light site look dark, or the theme switches off while the window is open.
   */

  /** Opacity of an element including its ancestors. */
  function effectiveOpacity(el) {
    let o = 1;
    for (let n = el; n && n.nodeType === 1 && o > 0.01; n = parentOf(n)) {
      const v = parseFloat(getComputedStyle(n).opacity);
      if (Number.isFinite(v)) o *= v;
    }
    return o;
  }

  /**
   * Whether an element belongs to something laid over the page: the top layer (<dialog>,
   * popovers) or a fixed layer painted over the page's text anywhere on screen (a modal and its
   * backdrop, a cookie banner). A fixed layer under the text is the page background itself (some
   * dark sites use one) and counts. `memo` keeps the answer per fixed layer for one check.
   */
  function inOverlay(el, memo) {
    try {
      if (el.closest(':modal')) return true;
    } catch (e) { /* selector not supported */ }
    try {
      if (el.closest(':popover-open')) return true;
    } catch (e) { /* selector not supported */ }
    let fixed = null;
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = parentOf(n)) {
      if (getComputedStyle(n).position === 'fixed') fixed = n;
    }
    if (!fixed) return false;
    if (!memo.has(fixed)) {
      // Bounded work per check: past 8 fixed layers the rest are taken for overlays.
      memo.set(fixed, memo.size >= 8 ? true : textUnder(fixed, fixed.getBoundingClientRect()));
    }
    return memo.get(fixed);
  }

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
        const overlayMemo = new Map();
        for (const [x, y] of points) {
          const stack = document.elementsFromPoint(x, y);
          let lum = rootLum;
          for (const el of stack) {
            if (el === html) break;
            if (el.localName === 'img' || el.localName === 'video' || el.localName === 'canvas') continue;
            if (inOverlay(el, overlayMemo)) continue;
            const c = parseColor(getComputedStyle(el).backgroundColor);
            if (c && c.a * effectiveOpacity(el) >= 0.6) { lum = luminance(c); break; }
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
      let relevant = false, images = false, excl = false, theme = false;
      for (const k of Object.keys(changes)) {
        if (!(k in D.DEFAULTS)) continue;
        relevant = true;
        const v = changes[k].newValue;
        settings[k] = v === undefined ? D.DEFAULTS[k] : v;
        if (D.IMAGE_KEYS.includes(k) || k === 'engine') images = true;
        if (k === 'exclusions') excl = true;
        if (['useSiteThemes', 'enabled', 'sites', 'schedule', 'scheduleFrom', 'scheduleTo'].includes(k)) theme = true;
      }
      if (!relevant) return;
      if (theme) applySiteTheme();
      const exclChanged = excl && refreshExclusions();
      if (images) resetMarks();
      update(images || exclChanged);
      if (isTop && settings.detectDarkSites) scheduleDetect();
    });

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg) return;
      if (msg.type === 'getStatus' && isTop) {
        const ruled = settings && host && D.findOverride(settings, host);
        const scheduleOff = !!(settings && !ruled && settings.enabled && !D.scheduleActive(settings, new Date(), systemDark()));
        sendResponse({ ready: !!settings, active: mode === 'full', nativeDark, host, scheduleOff, siteTheme: siteThemeOn });
      } else if (msg.type === 'pickElement' && isTop) {
        startPicker();
        sendResponse({ ok: !!picking });
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
    exclSelector = computeExclusions();
    applySiteTheme();
    update();

    // Sizes decide what is a colour swatch or a drawing surface: look again when they change
    // (and when a page that was loaded in a hidden window or tab is shown).
    // Only when the window size really changed since the last full scan (or the page was laid out
    // with no size at all): a full scan of a big page is not free, and switching tabs is frequent.
    let resizeTimer = 0;
    const rescan = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!mode || dead) return;
        const area = innerWidth * innerHeight;
        if (lastScanArea > 0 && Math.abs(area - lastScanArea) / lastScanArea < 0.2) return;
        editorCheck.at = -Infinity;
        fullScan();
      }, 500);
    };
    window.addEventListener('resize', rescan);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      rescan();
      // The schedule may have switched while the tab was in the background (a sleeping computer
      // delays timers; a system theme change may come without an event).
      if (isTop && settings && settings.schedule !== 'always') { applySiteTheme(); update(); }
    });

    if (isTop) {
      whenBody(detectNativeDark);
      document.addEventListener('DOMContentLoaded', detectNativeDark, { once: true });
      window.addEventListener('load', () => {
        detectNativeDark();
        if (mode) fullScan(); // CSS loaded late may have added background pictures
        setTimeout(() => { detectNativeDark(); persistNativeDark(); }, 1500);
      }, { once: true });
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        scheduleDetect();
        if (settings.schedule === 'system') { applySiteTheme(); update(); }
      });
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
