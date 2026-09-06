#!/usr/bin/env python3
"""Create, verify, or restore a paired Crate D1/R2 archive. See docs/recovery.md."""
import argparse
import os
import sys
from pathlib import Path
from recovery.archive import verify
from recovery.backup import backup
from recovery.restore import restore
from recovery.cloudflare import Cloudflare


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['backup', 'verify', 'restore'])
    parser.add_argument('directory', type=Path)
    parser.add_argument('--account')
    parser.add_argument('--database')
    parser.add_argument('--bucket')
    args = parser.parse_args()
    os.umask(0o077)
    if args.action == 'verify':
        manifest, verified_db = verify(args.directory)
        verified_db.close()
        print(f'Verified database and {len(manifest["objects"])} objects')
        return
    if not all((args.account, args.database, args.bucket)):
        parser.error('--account, --database, and --bucket are required')
    remote = Cloudflare(args.account, args.database, args.bucket)
    if args.action == 'backup':
        manifest = backup(remote, args.directory)
        print(f'Complete archive: {len(manifest["objects"])} verified objects')
    else:
        restore(remote, args.directory)
        print('Restored and verified. Enroll devices in the new deployment after following docs/recovery.md.')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Network error representations may contain credential-bearing signed URLs.
        print(f'Recovery stopped ({type(error).__name__}). No destructive cleanup was performed. Check the archive with verify and keep any partial restore offline.', file=sys.stderr)
        sys.exit(1)
