#!/usr/bin/env bash
# The lockstep release: client and backend SDK are ONE version. This sets
# the number in the four places that carry it — each package's package.json
# and src/sdkVersion.ts — proves they agree (assert-sdk-version.mjs), then
# commits and tags `sdk-vX.Y.Z`. Publishing is the one step after it:
#   npm publish -w @phantom-agent-sdk/client && npm publish -w @phantom-agent-sdk/backend
# (needs the npm org; see docs/v1-plan.md §6). Run from anywhere in the repo.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: $0 X.Y.Z"; exit 1; }
[ -z "$(git status --porcelain packages scripts)" ] || { echo "the SDK tree has uncommitted changes — commit or stash first"; exit 1; }

for name in client backend; do
  dir="packages/$name"
  node -e '
    const fs = require("node:fs"); const [file, version] = process.argv.slice(1);
    const pkg = JSON.parse(fs.readFileSync(file, "utf8")); pkg.version = version;
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  ' "$dir/package.json" "$VERSION"
  sed -i.bak -E "s/SDK_VERSION = '[^']+'/SDK_VERSION = '$VERSION'/" "$dir/src/sdkVersion.ts" && rm "$dir/src/sdkVersion.ts.bak"
done
# The backend depends on the client by exact version.
node -e '
  const fs = require("node:fs"); const [file, version] = process.argv.slice(1);
  const pkg = JSON.parse(fs.readFileSync(file, "utf8")); pkg.dependencies["@phantom-agent-sdk/client"] = version;
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
' packages/backend/package.json "$VERSION"

node scripts/assert-sdk-version.mjs
# The lockfile records workspace versions too; it lives at the repo root.
root="$(git rev-parse --show-toplevel)"
(cd "$root" && npm install --package-lock-only --no-audit --no-fund >/dev/null && git add package-lock.json)
git add packages/client/package.json packages/client/src/sdkVersion.ts packages/backend/package.json packages/backend/src/sdkVersion.ts
git commit -m "phantom-agent-sdk $VERSION"
git tag "sdk-v$VERSION"
echo "phantom-agent-sdk $VERSION committed and tagged sdk-v$VERSION — push, then publish both packages"
