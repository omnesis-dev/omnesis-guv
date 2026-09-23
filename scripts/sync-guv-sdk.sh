#!/bin/sh
# SPDX-License-Identifier: MIT
# Copy the handler SDK that ships with the installed Guv into .guv-sdk/, where
# tsconfig.json maps @familiar/guv-handler-sdk. A copy rather than a link: the
# SDK imports zod, and a copy resolves it from this checkout's node_modules.
# The SDK must match the daemon, so it is found next to the `guv` on PATH;
# re-run this after upgrading Guv. GUV_SDK_DIR names another SDK directory.
set -eu
cd "$(dirname "$0")/.."
trap 'rm -rf .guv-sdk.tmp' EXIT

fail() {
  echo "$1" >&2
  exit 1
}

if [ -n "${GUV_SDK_DIR:-}" ]; then
  src=$GUV_SDK_DIR
else
  guv_bin=$(command -v guv) || fail "guv is not on PATH. Install Guv, or set GUV_SDK_DIR to its share/guv/sdk directory."
  src="$(dirname "$(readlink -f "$guv_bin")")/../share/guv/sdk"
fi
[ -f "$src/package.json" ] || fail "No Guv handler SDK at $src. Set GUV_SDK_DIR to the SDK that ships with your Guv."
[ -d node_modules/zod ] || fail "Run bun install first."

version_of() {
  bun -e 'const p = require(process.argv[1]); console.log(process.argv[2] ? p.dependencies?.[process.argv[2]] ?? "" : p.version)' "$1" "${2:-}"
}
sdk_zod=$(version_of "$src/package.json" zod)
own_zod=$(version_of "$PWD/package.json" zod)
[ -n "$sdk_zod" ] || fail "The SDK at $src declares no zod dependency; this script does not know that SDK."
[ "$sdk_zod" = "$own_zod" ] || fail "The Guv SDK needs zod $sdk_zod but package.json pins $own_zod. Pin $sdk_zod, run bun install, and re-run."

rm -rf .guv-sdk.tmp
cp -R "$src" .guv-sdk.tmp
rm -rf .guv-sdk
mv .guv-sdk.tmp .guv-sdk
echo "Copied Guv handler SDK $(version_of "$PWD/.guv-sdk/package.json") from $(cd "$src" && pwd -P)."
