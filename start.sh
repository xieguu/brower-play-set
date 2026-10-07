#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if [[ ! -f .env ]]; then
  printf '%s\n' 'Missing .env. Run bash setup.sh first.' >&2
  exit 1
fi
exec node --env-file=.env src/server.js
