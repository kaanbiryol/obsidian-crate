#!/bin/sh
set -eu
umask 077

# Only the image entrypoint may manage this dedicated Docker volume. flock is
# already held across all containers, so any file lock here is left by a crash.
# Never use this recovery path for a host npx server's data directory.
rm -f /data/server/server.lock
exec node /opt/crate/scripts/crate-server.mjs "$@" --data-dir /data/server
