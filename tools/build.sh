#!/usr/bin/env bash
# Builds dist/dark-theme-everywhere.zip from the files tracked in git (the same set as build.ps1)
# and writes its SHA-256 next to it. Used by CI; works on Linux and macOS.
#
# The zip is reproducible: files are sorted, timestamps are set to the commit time and extra
# attributes are left out, so the same commit always gives the same checksum.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
name=dark-theme-everywhere
dist="$root/dist"
build="$dist/$name"

rm -rf "$build" "$dist/$name.zip" "$dist/$name.zip.sha256"
mkdir -p "$build"

cd "$root"
# Only tracked files: nothing from a local working copy (keys, temp files) can end up in the package.
git ls-files -z manifest.json _locales src popup options ui icons | xargs -0 -I{} cp --parents {} "$build/"

stamp=$(git log -1 --format=%ct)
find "$build" -exec touch -h -d "@$stamp" {} +

(cd "$build" && find . -type f | sed 's#^\./##' | LC_ALL=C sort | TZ=UTC zip -q -X -D "$dist/$name.zip" -@)
(cd "$dist" && sha256sum "$name.zip" > "$name.zip.sha256")

echo "ZIP:    $dist/$name.zip"
echo "SHA256: $(cut -d' ' -f1 "$dist/$name.zip.sha256")"
