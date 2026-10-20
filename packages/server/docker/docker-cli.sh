#!/bin/sh
set -eu
exec node /opt/crate/scripts/crate-server.mjs "$@" --data-dir /data/server
