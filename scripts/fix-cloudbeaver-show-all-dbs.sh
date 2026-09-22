#!/usr/bin/env bash
# One-shot fix: make CloudBeaver show all databases (including agent workspace_* dbs).
# Run from the phantom-looper install directory, then delete this script.
set -euo pipefail

docker compose exec cloudbeaver bash -c '
  f=$(find /opt/cloudbeaver/workspace -name "data-sources.json" | head -1)
  if [ -z "$f" ]; then echo "data-sources.json not found"; exit 1; fi
  cp "$f" "$f.bak"
  if grep -q "provider-properties" "$f"; then
    sed -i "s/\"provider-properties\": {/\"provider-properties\": { \"@dbeaver-show-non-default-db@\": \"true\",/" "$f"
  else
    sed -i "s/\"configuration\": {/\"configuration\": { \"provider-properties\": { \"@dbeaver-show-non-default-db@\": \"true\" },/" "$f"
  fi
  echo "patched: $f"
'

docker compose restart cloudbeaver
echo "done — CloudBeaver restarting"
