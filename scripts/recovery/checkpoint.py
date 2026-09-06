"""Small, credential-free checkpoints written atomically before remote changes."""
import json
import os
from pathlib import Path


def identity(remote):
    return {'account': remote.account, 'database': remote.database, 'bucket': remote.bucket}


def atomic_write(path, data):
    path = Path(path)
    temporary = path.with_name(path.name + '.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    if os.name != 'nt':
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)


def save(path, value):
    atomic_write(path, (json.dumps(value, sort_keys=True, indent=2) + '\n').encode())
