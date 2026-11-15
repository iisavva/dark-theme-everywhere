# Dark Theme Everywhere

A browser extension (Manifest V3) that makes any website dark.
Works in Chrome, Edge, Yandex Browser, Opera, Brave, Firefox 121+ and Safari 16.4+ (macOS).

The interface is in English by default and also available in Russian: switch the language at the
bottom of the popup or at the top of the options page. The extension's name and description in the
browser's extension list follow the browser's own language (Russian for a Russian browser,
English otherwise).

## Features

- **Dark theme for any website**, including sites with inline styles, canvas and iframes.
- **Toggle for all sites and for a specific site.** The popup has a global switch, "All sites",
  and a three-way control for the current site: "Default / On / Off". A site rule takes priority over the global switch; a rule
  for `example.com` also applies to its subdomains. The full list of rules is on the options page.
- **Smart image handling:**
  - photos, videos and canvas keep their original colours;
  - a black logo on a transparent background (which would vanish on a dark page) becomes light;
  - a white logo from a dark header (the header turns light after inversion) becomes dark;
  - the decision is based on the contrast between the image and the actual background behind it;
    it works for `<img>`, SVG files and icons set via CSS `background-image`;
  - light pictures with black text (diagrams, document screenshots) can optionally be inverted.
  - colourful inline SVG illustrations and animations (Lottie and the like) keep their colours like
    pictures; single-colour SVG icons and SVG charts with labels are themed with the page.
- **Colour palettes keep their real colours.** A group of small clickable colour swatches (brush
  colours on an online whiteboard, colour choice in a shop) is shown in original colours, so a black
  swatch stays black. On whiteboards and editors (a palette plus a large canvas or SVG: Holst, Miro,
  Excalidraw, draw.io, FigJam and the like) the drawing area is shown in original colours too, on the
  page's original background, so a stroke looks exactly like the colour picked for it; the editor's
  UI around it stays dark. `<input type="color">` keeps its colour as well.
- **Google Sheets:** the cell grid (drawn on one large canvas) is dark like the rest of the page;
  charts and pictures in a sheet keep their colours.
- **Video players are left as on the site.** A player on the page (the video with its controls,
  progress bar, title and captions) is not themed, and neither are players embedded in an iframe
  (YouTube, Vimeo, Rutube, VK Video, OK, Dzen, Dailymotion, Twitch and others, or any frame that is
  mostly one video).
- **Sites that are already dark** are detected and left alone (otherwise they would turn light).
  To force the theme on such a site, press "On".
- Brightness, contrast, sepia, grayscale and image brightness settings.
- Keyboard shortcuts: `Alt+Shift+D` for the current site, `Alt+Shift+G` for all sites.

## Installation (developer mode)

The easiest way is to download the ready-made `dark-theme-everywhere.zip` from the
[Releases](https://github.com/iisavva/dark-theme-everywhere/releases/latest) page, unpack it
and load the resulting folder using the steps below.

Starting with v1.0.1, releases are built by GitHub Actions from the tagged commit, and each
release lists the SHA-256 checksum of the zip (also attached as `dark-theme-everywhere.zip.sha256`).
Check it before installing:

```bash
sha256sum dark-theme-everywhere.zip
```

On Windows (PowerShell): `Get-FileHash dark-theme-everywhere.zip`. The result must match the
checksum on the release page.

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

**Safari 16.4+ (macOS 11 Big Sur or newer)**

Safari extensions are shipped inside a macOS app. Releases contain
`Dark-Theme-Everywhere-Safari.zip` with an **unsigned** app (signing needs a paid Apple
Developer account), so Safari loads it only in developer mode:

1. Unpack the zip and move `Dark Theme Everywhere.app` to `Applications`.
2. The app is not notarised, so macOS blocks the first launch. Allow it in
   System Settings → Privacy & Security → "Open Anyway", or run
   `xattr -dr com.apple.quarantine "/Applications/Dark Theme Everywhere.app"`.
3. Open the app once.
4. In Safari: Settings → Advanced → turn on "Show features for web developers"
   (older versions: "Show Develop menu in menu bar"), then Develop → "Allow Unsigned Extensions".
5. Safari → Settings → Extensions → enable "Dark Theme Everywhere" and set
   "Always Allow on Every Website" for it.

"Allow Unsigned Extensions" is reset every time Safari quits, so step 4 has to be repeated
after each Safari restart. A signed build (see below) does not have this limitation.

Keyboard shortcuts on a Mac use Option instead of Alt: `Option+Shift+D` / `Option+Shift+G`.

## Building the Safari version

Needs a Mac with Xcode 14.3+:

```bash
bash tools/build-safari.sh
```

It writes the Safari manifest (`tools/safari/manifest.js`: service worker only, no
Firefox-specific keys), converts the extension with `safari-web-extension-converter` and builds
the app. Output in `dist/safari/`: the Xcode project, the app and
`Dark-Theme-Everywhere-Safari.zip`.

To sign with your Apple Developer team instead of building an unsigned app:

```bash
SIGN=1 TEAM_ID=ABCDE12345 bash tools/build-safari.sh
```

For the App Store, open the generated Xcode project in `dist/safari/Dark Theme Everywhere/`,
choose your team and use Product → Archive.

The `Safari` GitHub Actions workflow builds the app on macOS for every change, and the release
workflow adds `Dark-Theme-Everywhere-Safari.zip` to each release.

## Building .crx and .zip

On Linux or macOS, `tools/build.sh` builds the zip (the same way CI does) and prints its SHA-256.
The build is reproducible: the same commit always gives the same checksum.

```bash
bash tools/build.sh
```

On Windows, `tools/build.ps1` also builds a signed `.crx`:

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

## Releasing

1. Bump `"version"` in `manifest.json` and merge it into `main`.
2. Tag that commit and push the tag, for example:

   ```bash
   git tag v1.0.1
   git push origin v1.0.1
   ```

The release workflow checks that the tag matches `manifest.json`, runs the tests, builds the zip
from the tagged commit and publishes the release with its checksum. The `.crx` is not built in CI:
signing it would need the private key; build it with `tools/build.ps1` and attach it by hand if needed.

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

## Security

Images from other domains are downloaded by the background worker, which is not bound by CORS or
by the browser's restrictions on pages. So that a page cannot abuse it:

- the worker downloads without cookies, and only pixel statistics leave it;
- addresses in the local network (localhost, private IPs, `.local`, single-label names) are not
  downloaded for public pages, and neither are redirects into the local network;
- a background picture is analysed only after the page itself has loaded it, so the browser's own
  rules for the page (for example, the block on reaching local network devices) apply. This covers
  public names that point to private addresses (`192.168.1.1.nip.io`), which a name check cannot see;
- one page may have pictures from at most 40 hosts analysed, which stops it from probing many
  addresses; tabs have separate, size-limited download queues that take turns;
- an iframe only learns whether the page around it is themed.

Residual risk: with DNS rebinding (a name that resolves to a public address for the page and to a
private one a moment later for the extension) a page can still make up to 40 cookie-less GET
requests to the local network per page load and learn the rough brightness of a picture there.

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
- Whiteboards that draw every shape as a separate small SVG instead of one canvas or SVG (tldraw,
  for example) are not recognised as a drawing area: there the shapes are themed with the page.
- The browser does not allow extensions to run on internal pages (`chrome://`, the extension store).
- For local files (`file://`) in Chrome, turn on "Allow access to file URLs" on the extension's card.
