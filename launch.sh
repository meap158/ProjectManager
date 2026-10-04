#!/usr/bin/env sh
# Starts ProjectManager. Same as: npm run launch
set -e
cd "$(dirname "$0")"
exec node scripts/launch.mjs "$@"
