#!/usr/bin/env sh
# Starts ProjectManager. Same as: npm run launch
if [ -t 1 ]; then printf '\033]0;%s\007' 'ProjectManager - Server'; fi
set -e
cd "$(dirname "$0")"
exec node scripts/launch.mjs "$@"
