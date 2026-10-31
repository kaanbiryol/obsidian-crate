"""Copy an in-bucket upgrade checkpoint into the standard paired archive format."""
import json
import re
from pathlib import Path
from .archive import digest, object_path, verify
from .checkpoint import atomic_write, identity, save

# Format 2 backups share content-addressed file copies under this reserved prefix.
STORE = '__crate__/backups/schema-upgrade-ffffffff-ffff-ffff-ffff-ffffffffffff'
SHA256 = re.compile(r'[a-f0-9]{64}')


def checkpoint_database(remote, prefix, manifest):
    """Return verified export bytes and where each original object's copy is stored."""
    if manifest.get('format') != 2 or not manifest.get('databaseParts'):
        raise ValueError('Unsupported upgrade checkpoint format')
    parts = []
    # Parts end at statement boundaries; their concatenation is the database export.
    for part in manifest['databaseParts']:
        if not SHA256.fullmatch(str(part.get('sha256'))):
            raise ValueError('Invalid checkpoint database part')
        data = remote.get_object(prefix + '/objects/' + part['sha256'])[0]
        if digest(data) != part['sha256'] or len(data) != part['size']:
            raise ValueError('Checkpoint database checksum mismatch')
        parts.append(data)

    def location(item):
        if not SHA256.fullmatch(str(item.get('sha256'))):
            raise ValueError('Invalid checkpoint object checksum')
        return STORE + '/objects/' + item['sha256']
    return b''.join(parts), location


def download_checkpoint(remote, directory, prefix):
    if not re.fullmatch(r'__crate__/backups/schema-upgrade-[a-f0-9-]{36}', prefix) or prefix == STORE:
        raise ValueError('Invalid upgrade checkpoint prefix')
    directory = Path(directory)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if any(directory.iterdir()):
        raise ValueError('Use a new empty checkpoint directory')
    (directory / 'objects').mkdir(mode=0o700)
    manifest = json.loads(remote.get_object(prefix + '/archive.json')[0])
    if manifest.get('source') != identity(remote) or manifest.get('complete') is not True:
        raise ValueError('Checkpoint source does not match this server')
    sql, location = checkpoint_database(remote, prefix, manifest)
    atomic_write(directory / 'database.sql', sql)
    for item in manifest['objects']:
        data = remote.get_object(location(item))[0]
        if digest(data) != item['sha256'] or len(data) != item['size']:
            raise ValueError('Checkpoint object checksum mismatch')
        atomic_write(object_path(directory, item['key']), data)
    # The local archive always uses the single-file layout that verify and restore read.
    archive = {key: value for key, value in manifest.items() if key != 'databaseParts'}
    archive.update(format=1, databaseSha256=digest(sql))
    save(directory / 'archive.json', archive)
    _, db = verify(directory)
    db.close()
    return archive
