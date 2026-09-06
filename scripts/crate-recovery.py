#!/usr/bin/env python3
"""Create, verify, or restore a paired Crate D1/R2 archive. See docs/recovery.md."""
import argparse
import json
import os
import sys
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from recovery.archive import database_contents, digest, load_database, object_path, references, verify, prepare_restore_sql
from recovery.cloudflare import Cloudflare


def backup(remote, directory):
    directory = Path(directory)
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    (directory / 'objects').mkdir(mode=0o700)
    sql, bookmark = remote.export()
    (directory / 'database.sql').write_bytes(sql)
    with closing(load_database(sql)) as db:
        expected = references(db)
    items = []
    for index, (key, (sha, size)) in enumerate(expected.items()):
        data, content_type = remote.get_object(key)
        if digest(data) != sha or len(data) != size:
            raise ValueError('Source object is missing or corrupt; archive is incomplete')
        object_path(directory, key).write_bytes(data)
        items.append({'key': key, 'sha256': sha, 'size': size, 'contentType': content_type})
        if (index + 1) % 100 == 0:
            print(f'Verified {index + 1} objects', flush=True)
    # Settings are an independent R2 object, not part of the D1 transaction.
    try:
        data, content_type = remote.get_object('__crate__/settings.json')
    except RuntimeError as error:
        if str(error) != 'Cloudflare request failed with HTTP 404':
            raise
    else:
        key = '__crate__/settings.json'
        object_path(directory, key).write_bytes(data)
        items.append({'key': key, 'sha256': digest(data), 'size': len(data), 'contentType': content_type})
    manifest = {'format': 1, 'complete': True, 'createdAt': datetime.now(timezone.utc).isoformat(),
                'source': {'account': remote.account, 'database': remote.database, 'bucket': remote.bucket},
                'bookmark': bookmark, 'databaseSha256': digest(sql), 'objects': items}
    (directory / 'archive.json').write_text(json.dumps(manifest, indent=2) + '\n')
    _, checked_db = verify(directory)
    checked_db.close()
    return manifest


def restore(remote, directory):
    manifest, verified_db = verify(directory)
    verified_db.close()
    source = manifest['source']
    if remote.account == source['account'] and (remote.database == source['database'] or remote.bucket == source['bucket']):
        raise ValueError('Restore cannot target either source resource')
    sql = prepare_restore_sql(directory)
    remote.require_empty()
    # Bytes precede metadata; a failed upload can never publish a dangling pointer.
    for item in manifest['objects']:
        data = object_path(directory, item['key']).read_bytes()
        remote.put_object(item['key'], data, item.get('contentType', 'application/octet-stream'))
        uploaded, _type = remote.get_object(item['key'])
        if digest(uploaded) != item['sha256']:
            raise ValueError('Restored R2 object checksum mismatch; D1 has not been imported')
    remote.import_sql(sql)
    restored_sql, _bookmark = remote.export()
    with closing(load_database(restored_sql)) as restored_db, closing(load_database(sql)) as expected_db:
      if database_contents(restored_db) != database_contents(expected_db):
        raise ValueError('Restored database contents differ; keep the target offline')


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
