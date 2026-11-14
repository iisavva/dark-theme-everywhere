# Dark Theme Everywhere

A browser extension (Manifest V3) that makes any website dark.
Works in Chrome, Edge, Yandex Browser, Opera, Brave and Firefox 121+.

The extension's interface is in Russian; Russian labels are given in parentheses below.

## Features

- **Dark theme for any website**, including sites with inline styles, canvas and iframes.
- **Toggle for all sites and for a specific site.** The popup has a global switch, "All sites"
  («Все сайты»), and a three-way control for the current site: "As everywhere / On / Off"
  («Как везде / Включить / Выключить»). A site rule takes priority over the global switch; a rule
  for `example.com` also applies to its subdomains. The full list of rules is on the options page.
- **Smart image handling:**
  - photos, videos and canvas keep their original colours;
  - a black logo on a transparent background (which would vanish on a dark page) becomes light;
  - a white logo from a dark header (the header turns light after inversion) becomes dark;
  - the decision is based on the contrast between the image and the actual background behind it;
    it works for `<img>`, SVG files and icons set via CSS `background-image`;
  - light pictures with black text (diagrams, document screenshots) can optionally be inverted.
- **Sites that are already dark** are detected and left alone (otherwise they would turn light).
  To force the theme on such a site, press "On" («Включить»).
- Brightness, contrast, sepia, grayscale and image brightness settings.
- Keyboard shortcuts: `Alt+Shift+D` for the current site, `Alt+Shift+G` for all sites.

## Installation (developer mode)

The easiest way is to download the ready-made `dark-theme-everywhere.zip` from the
[Releases](https://github.com/iisavva/dark-theme-everywhere/releases/latest) page, unpack it
and load the resulting folder using the steps below.

Or get the source code:

```bash
git clone https://github.com/iisavva/dark-theme-everywhere.git
```

(or Code → Download ZIP on the repository page, then unpack it).

**Chrome / Edge / Yandex / Opera / Brave**

1. Open `chrome://extensions` (in Edge, `edge://extensions`).
2. Turn on "Developer mode".
3. Click "Load unpacked" and select this folder (the one containing `manifest.json`).
4. Pin the extension icon to the toolbar.

**Firefox**

1. Open `about:debugging#/runtime/this-firefox`.
2. Click "Load Temporary Add-on…" and select `manifest.json`.
3. In `about:addons` → the extension → "Permissions", allow access to all sites
   (Firefox turns it off by default for MV3 extensions).

## Building .crx and .zip

```bash
powershell -ExecutionPolicy Bypass -File tools/build.ps1
```

The script uses the installed Chrome or Edge and creates:

- `dist/dark-theme-everywhere.crx`: a signed CRX3 package;
- `dist/dark-theme-everywhere.zip`: an archive for uploading to the Chrome Web Store or addons.mozilla.org;
- `dist/dark-theme-everywhere/`: a clean extension folder (it can be loaded as an unpacked extension).

The first build creates the private key `keys/dark-theme-everywhere.pem`. Later builds are signed
with the same key, so the extension ID stays the same. The key is secret: do not publish it
(`keys/` and `dist/` are in `.gitignore`).

Chrome and Edge on Windows usually refuse to install a `.crx` that does not come from the store:
you get an error, or the extension is disabled right away. For personal use it is simpler to load
the `dist/dark-theme-everywhere` folder via "Load unpacked". A `.crx` is fine for Linux/macOS, for
browsers with relaxed rules (Yandex, Opera) and for installation via enterprise policies.

## How it works

| File | What it does |
|---|---|
| `src/content.js` | Applies the theme: an `invert + hue-rotate` filter on `<html>`, inverting media back, image analysis, dark site detection |
| `src/background.js` | Analyses images from other domains (only statistics leave it, never the image itself), the toolbar icon, keyboard shortcuts, communication with iframes |
| `src/shared.js` | Default settings, site rules, pixel statistics |
| `popup/` | The popup |
| `options/` | The options page and the site list |
| `tools/make_assets.py` | Generates the icons and test images (`python tools/make_assets.py`, requires Pillow) |
| `test/` | Test pages |

An image is analysed like this: a reduced copy (up to 96 px) is drawn on a canvas, and the extension
computes the share of transparent pixels, the average brightness, the share of saturated colours and
how "paper-like" it is (a white background with dark strokes). For transparent images it compares
the contrast of two variants, original and inverted, against the background that will be behind the
image after darkening, and picks the better one.

## Testing without installing

```bash
python -m http.server 8766
```

Open `http://127.0.0.1:8766/test/index.html?stub`: the same `content.js` runs there on a stub of the
browser API. With the extension installed, open the page without `?stub`.
`test/dark.html` is an example of a site that is already dark.

## Limitations

- Colour emoji in text are inverted along with the text.
- Images inside a closed Shadow DOM are not processed.
- The browser does not allow extensions to run on internal pages (`chrome://`, the extension store).
- For local files (`file://`) in Chrome, turn on "Allow access to file URLs" on the extension's card.
