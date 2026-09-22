"""Copy an in-bucket upgrade checkpoint into the standard paired archive format."""
import json
import re
from pathlib import Path
from .archive import digest, object_path, verify
from .checkpoint import atomic_write, identity, save


def download_checkpoint(remote, directory, prefix):
    if not re.fullmatch(r'__crate__/backups/schema-upgrade-[a-f0-9-]{36}', prefix):
        raise ValueError('Invalid upgrade checkpoint prefix')
    directory = Path(directory)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if any(directory.iterdir()):
        raise ValueError('Use a new empty checkpoint directory')
    (directory / 'objects').mkdir(mode=0o700)
    manifest = json.loads(remote.get_object(prefix + '/archive.json')[0])
    if manifest.get('source') != identity(remote) or manifest.get('complete') is not True:
        raise ValueError('Checkpoint source does not match this server')
    sql = remote.get_object(prefix + '/database.sql')[0]
    if digest(sql) != manifest['databaseSha256']:
        raise ValueError('Checkpoint database checksum mismatch')
    atomic_write(directory / 'database.sql', sql)
    for item in manifest['objects']:
        data = remote.get_object(prefix + '/objects/' + digest(item['key'].encode()))[0]
        if digest(data) != item['sha256'] or len(data) != item['size']:
            raise ValueError('Checkpoint object checksum mismatch')
        atomic_write(object_path(directory, item['key']), data)
    save(directory / 'archive.json', manifest)
    _, db = verify(directory)
    db.close()
    return manifest
