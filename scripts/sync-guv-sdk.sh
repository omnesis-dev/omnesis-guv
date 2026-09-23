#!/bin/sh
# SPDX-License-Identifier: MIT
# Copy the Guv handler SDK that ships with the installed guv into .guv-sdk/,
# where tsconfig.json maps @familiar/guv-handler-sdk. A copy rather than a
# link: the SDK imports zod, and a copy resolves it from this checkout's
# node_modules. Re-run after upgrading Guv; the SDK must match the daemon.
set -eu
cd "$(dirname "$0")/.."

if [ -n "${GUV_SDK_DIR:-}" ]; then
  src=$GUV_SDK_DIR
elif command -v brew >/dev/null 2>&1 && [ -d "$(brew --prefix guv 2>/dev/null)/share/guv/sdk" ]; then
  src="$(brew --prefix guv)/share/guv/sdk"
elif [ -d "$HOME/.local/share/guv/sdk" ]; then
  src="$HOME/.local/share/guv/sdk"
else
  echo "No Guv handler SDK found. Install Guv, or set GUV_SDK_DIR to its share/guv/sdk directory." >&2
  exit 1
fi

sdk_zod=$(bun -e 'console.log(require(process.argv[1]).dependencies?.zod ?? "")' "$src/package.json")
own_zod=$(bun -e 'console.log(require(process.argv[1]).dependencies?.zod ?? "")' "$PWD/package.json")
if [ "$sdk_zod" != "$own_zod" ]; then
  echo "The Guv SDK needs zod $sdk_zod but package.json pins $own_zod. Pin $sdk_zod, run bun install, and re-run." >&2
  exit 1
fi

rm -rf .guv-sdk.tmp
cp -R "$src" .guv-sdk.tmp
rm -rf .guv-sdk
mv .guv-sdk.tmp .guv-sdk
echo "Copied Guv handler SDK $(bun -e 'console.log(require(process.argv[1]).version)' "$PWD/.guv-sdk/package.json") from $src"
