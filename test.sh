#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# Extension tests use local fixtures and the faux provider, never real providers.
node scripts/run-extension-script.mjs test
