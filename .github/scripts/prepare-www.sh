#!/usr/bin/env bash
# Copy the SONIQ web app (repo root) into app/www for Capacitor.
set -euo pipefail
cd "$(dirname "$0")/../.."
rm -rf app/www && mkdir -p app/www
tar --exclude='./.git' --exclude='./.github' --exclude='./app' --exclude='./node_modules' \
  --exclude='*.md' --exclude='./lib_*.png' --exclude='./styles2_*.png' -cf - . | tar -xf - -C app/www
echo "www files: $(find app/www -type f | wc -l)"
test -f app/www/index.html
