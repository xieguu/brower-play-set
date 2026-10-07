#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("Node.js 22+ required"); process.exit(1); }'
npm ci
npx playwright install --with-deps --no-shell chromium
if [[ "$(uname -s)" == "Linux" ]]; then
  if [[ "$EUID" -eq 0 ]]; then
    apt-get update
    apt-get install -y --no-install-recommends xvfb x11vnc fonts-noto-cjk
  else
    sudo apt-get update
    sudo apt-get install -y --no-install-recommends xvfb x11vnc fonts-noto-cjk
  fi
fi
if [[ ! -f .env ]]; then
  (umask 077; cp .env.example .env)
fi
printf '%s\n' 'Set BPS_ADMIN_PASSWORD in .env, then run: bash start.sh'
