#!/usr/bin/env bash
# Regenerate the platform icon sets from build/icon.png. macOS only — sips and
# iconutil are what do the work, and both ship with the OS.
#
# build/icon.png is the source of truth: a square, transparent PNG of the
# artwork alone, edge to edge. Linux and Windows want exactly that (Windows
# converts it to .ico at build time; Linux takes the sizes in build/icons).
#
# macOS is the exception, and the reason this script exists: an app icon there is
# drawn at 824 of a 1024 canvas, the rest transparent, so that every icon in the
# dock shares one visual size. Handing the full-bleed artwork to electron-builder
# instead — which converts icon.png when there is no .icns — makes Specterm sit
# noticeably larger than everything beside it.
set -euo pipefail

cd "$(dirname "$0")/.."
src="build/icon.png"
[ -f "$src" ] || { echo "missing $src" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
set="$work/Specterm.iconset"
mkdir -p "$set" build/icons

# The macOS master: artwork at 824, centred on a transparent 1024 canvas.
# `sips -p` pads with transparency when the source has an alpha channel.
sips -z 824 824 "$src" --out "$work/art.png" >/dev/null
sips -p 1024 1024 "$work/art.png" --out "$work/mac.png" >/dev/null

# The same shape at 512, for the dock icon in an unpackaged run — Electron's
# nativeImage can't read an .icns (not ours, not the system's), so the dock needs
# this as a png or it gets the full-bleed one and renders a quarter too large.
# 512 rather than 1024 because the dock never draws bigger than 256px, and this
# file exists purely for `npm run dev:electron`.
sips -z 412 412 "$src" --out "$work/dock-art.png" >/dev/null
sips -p 512 512 "$work/dock-art.png" --out build/icon-dock.png >/dev/null

for s in 16 32 64 128 256 512 1024; do
  sips -z $s $s "$work/mac.png" --out "$work/mac-$s.png" >/dev/null
done
cp "$work/mac-16.png"   "$set/icon_16x16.png"
cp "$work/mac-32.png"   "$set/icon_16x16@2x.png"
cp "$work/mac-32.png"   "$set/icon_32x32.png"
cp "$work/mac-64.png"   "$set/icon_32x32@2x.png"
cp "$work/mac-128.png"  "$set/icon_128x128.png"
cp "$work/mac-256.png"  "$set/icon_128x128@2x.png"
cp "$work/mac-256.png"  "$set/icon_256x256.png"
cp "$work/mac-512.png"  "$set/icon_256x256@2x.png"
cp "$work/mac-512.png"  "$set/icon_512x512.png"
cp "$work/mac-1024.png" "$set/icon_512x512@2x.png"
iconutil -c icns "$set" -o build/icon.icns

# Linux: the full-bleed artwork at the sizes desktops ask for.
for s in 16 32 48 64 128 256 512; do
  sips -z $s $s "$src" --out "build/icons/${s}x${s}.png" >/dev/null
done

echo "wrote build/icon.icns, build/icon-dock.png and build/icons/*.png"
