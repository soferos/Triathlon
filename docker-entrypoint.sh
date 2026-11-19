#!/bin/sh
# A freshly mounted volume is owned by root. Fix that, then run the app as the unprivileged "node" user.
set -e
mkdir -p "${DATA_DIR:-/data}"
chown -R node:node "${DATA_DIR:-/data}"
exec runuser -u node -- "$@"
