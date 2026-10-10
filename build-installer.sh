#!/usr/bin/env bash
# Builds dist/PhoneDrop Setup *.exe. Packs, stamps the icon with rcedit, then wraps in NSIS.
# (Avoids electron-builder's winCodeSign step, which needs symlink privileges on Windows.)
set -e
cd "$(dirname "$0")"
rm -rf dist
npx electron-builder --win --dir
RCEDIT=$(ls -d "$LOCALAPPDATA"/electron-builder/Cache/winCodeSign/*/rcedit-x64.exe | head -1)
"$RCEDIT" dist/win-unpacked/PhoneDrop.exe --set-icon icon.ico \
  --set-version-string FileDescription PhoneDrop --set-version-string ProductName PhoneDrop
npx electron-builder --win nsis --prepackaged dist/win-unpacked
ls -la dist/*.exe
