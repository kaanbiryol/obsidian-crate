"""A pinned D1 export plus individually verified, resumable object downloads."""
import json
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from .archive import digest, load_database, object_path, references, verify
from .checkpoint import atomic_write, identity, save


def backup(remote, directory):
    directory = Path(directory)
    checkpoint = directory / 'backup-progress.json'
    source = identity(remote)
    if (directory / 'archive.json').exists():
        manifest, db = verify(directory)
        db.close()
        if manifest['source'] != source:
            raise ValueError('Completed backup belongs to another source')
        return manifest
    if directory.exists():
        if not checkpoint.exists():
            if any(path.name != 'backup-progress.json.tmp' for path in directory.iterdir()):
                raise ValueError('Existing directory has no backup checkpoint')
            save(checkpoint, {'format': 1, 'source': source})
        state = json.loads(checkpoint.read_text())
        if state.get('format') != 1 or state.get('source') != source:
            raise ValueError('Backup checkpoint belongs to another source')
    else:
        directory.mkdir(mode=0o700, parents=True)
        state = {'format': 1, 'source': source}
        save(checkpoint, state)
    (directory / 'objects').mkdir(mode=0o700, exist_ok=True)
    if 'databaseSha256' not in state:
        sql, bookmark = remote.export()
        atomic_write(directory / 'database.sql', sql)
        state.update(databaseSha256=digest(sql), bookmark=bookmark)
        save(checkpoint, state)
    sql = (directory / 'database.sql').read_bytes()
    if digest(sql) != state['databaseSha256']:
        raise ValueError('Pinned database export checksum mismatch')
    with closing(load_database(sql)) as db:
        expected = references(db)

    def capture(key, integrity=None):
        path = object_path(directory, key)
        metadata = path.with_suffix('.json')
        if path.exists() and metadata.exists():
            data, item = path.read_bytes(), json.loads(metadata.read_text())
        else:
            data, content_type = remote.get_object(key)
            item = {'key': key, 'sha256': digest(data), 'size': len(data), 'contentType': content_type}
            atomic_write(path, data)
            save(metadata, item)
        if item['key'] != key or digest(data) != item['sha256'] or len(data) != item['size']:
            raise ValueError('Downloaded object checkpoint is corrupt')
        if integrity and (item['sha256'], item['size']) != integrity:
            raise ValueError('Source object does not match the pinned database')
        return item

    items = []
    for index, (key, integrity) in enumerate(expected.items(), 1):
        items.append(capture(key, integrity))
        if index % 100 == 0:
            print(f'Verified {index} archive objects', flush=True)
    try:
        items.append(capture('__crate__/settings.json'))
    except RuntimeError as error:
        if str(error) != 'Cloudflare request failed with HTTP 404':
            raise
    manifest = {'format': 1, 'complete': True, 'createdAt': datetime.now(timezone.utc).isoformat(),
                'source': source, 'bookmark': state['bookmark'], 'databaseSha256': state['databaseSha256'], 'objects': items}
    save(directory / 'archive.json', manifest)
    _, db = verify(directory)
    db.close()
    return manifest
