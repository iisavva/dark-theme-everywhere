#!/usr/bin/env bash
# Builds the Safari version (macOS only, needs Xcode 14.3+).
#
#   bash tools/build-safari.sh            # Xcode project + unsigned app
#   SIGN=1 TEAM_ID=ABCDE12345 bash tools/build-safari.sh   # signed with your Apple Developer team
#
# Output in dist/safari/:
#   extension/                      – the web extension with the Safari manifest
#   Dark Theme Everywhere/          – Xcode project (open it in Xcode to sign, run or archive)
#   Dark-Theme-Everywhere-Safari.zip – the built app (Dark Theme Everywhere.app)
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
app_name="Dark Theme Everywhere"
bundle_id="${BUNDLE_ID:-io.github.iisavva.darkthemeeverywhere}"
out="$root/dist/safari"
ext="$out/extension"
derived="$out/build"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "The Safari version can only be built on macOS (Xcode is required)." >&2
  exit 1
fi
command -v xcrun >/dev/null || { echo "Xcode command line tools are not installed." >&2; exit 1; }

rm -rf "$out"
mkdir -p "$ext"

cd "$root"
# Only tracked files go into the package (same set as tools/build.sh).
git ls-files -z manifest.json src popup options ui icons | xargs -0 -I{} rsync -R {} "$ext/"
node tools/safari/manifest.js manifest.json "$ext/manifest.json"

version=$(node -p "require('./manifest.json').version")

xcrun safari-web-extension-converter "$ext" \
  --project-location "$out" \
  --app-name "$app_name" \
  --bundle-identifier "$bundle_id" \
  --swift \
  --macos-only \
  --copy-resources \
  --no-open \
  --no-prompt \
  --force

project=$(find "$out" -maxdepth 3 -name '*.xcodeproj' | head -n 1)
[[ -n "$project" ]] || { echo "Xcode project was not created" >&2; exit 1; }

# The converter derives the app's bundle ID from the app name and the extension's from
# --bundle-identifier, so they do not match, and Xcode refuses an extension whose ID does not
# start with the app's. Set both explicitly: app = $bundle_id, extension = $bundle_id.Extension.
ext_id="$bundle_id.Extension"
pbx="$project/project.pbxproj"
sed -E -i '' \
  -e "/PRODUCT_BUNDLE_IDENTIFIER = .*[Ee]xtension\"?;/ s/PRODUCT_BUNDLE_IDENTIFIER = .*;/PRODUCT_BUNDLE_IDENTIFIER = \"$ext_id\";/" \
  -e "/PRODUCT_BUNDLE_IDENTIFIER = .*[Ee]xtension\"?;/! s/PRODUCT_BUNDLE_IDENTIFIER = .*;/PRODUCT_BUNDLE_IDENTIFIER = \"$bundle_id\";/" \
  "$pbx"
# The app's Swift code asks Safari about the extension by its ID.
find "$(dirname "$project")" -name '*.swift' -print0 | xargs -0 sed -E -i '' \
  "s/(extensionBundleIdentifier[[:space:]]*=[[:space:]]*)\"[^\"]*\"/\1\"$ext_id\"/"
echo "Bundle IDs:"
grep -h 'PRODUCT_BUNDLE_IDENTIFIER' "$pbx" | sort -u
grep -rh 'extensionBundleIdentifier =' "$(dirname "$project")" --include='*.swift' || true
scheme=$(xcodebuild -list -json -project "$project" | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const schemes = JSON.parse(s).project.schemes;
    process.stdout.write(schemes.find((x) => !/Extension/.test(x)) || schemes[0]);
  });')
echo "Project: $project, scheme: $scheme"

sign_args=(CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= CODE_SIGNING_REQUIRED=NO)
if [[ "${SIGN:-0}" == "1" ]]; then
  [[ -n "${TEAM_ID:-}" ]] || { echo "SIGN=1 needs TEAM_ID" >&2; exit 1; }
  sign_args=(DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic -allowProvisioningUpdates)
fi

xcodebuild \
  -project "$project" \
  -scheme "$scheme" \
  -configuration Release \
  -derivedDataPath "$derived" \
  MACOSX_DEPLOYMENT_TARGET=11.0 \
  MARKETING_VERSION="$version" \
  CURRENT_PROJECT_VERSION="$version" \
  "${sign_args[@]}" \
  build > "$out/xcodebuild.log" 2>&1 || {
    grep -E 'error:|warning: .*(bundle|Bundle)|BUILD FAILED|Identifier' "$out/xcodebuild.log" >&2 || true
    tail -n 40 "$out/xcodebuild.log" >&2
    exit 1
  }
tail -n 3 "$out/xcodebuild.log"

app="$derived/Build/Products/Release/$app_name.app"
[[ -d "$app" ]] || { echo "App was not built" >&2; exit 1; }

zip="$out/Dark-Theme-Everywhere-Safari.zip"
ditto -c -k --keepParent "$app" "$zip"
(cd "$out" && shasum -a 256 "$(basename "$zip")" > "$(basename "$zip").sha256")

echo "App: $app"
echo "ZIP: $zip"
