"""Paired D1/R2 archives. No third-party Python dependencies."""
import hashlib
import json
import sqlite3
import time
from pathlib import Path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def load_database(sql):
    db = sqlite3.connect(':memory:')
    db.row_factory = sqlite3.Row
    def authorize(action, first, second, _database, _trigger):
        if action in (sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH):
            return sqlite3.SQLITE_DENY
        if action == sqlite3.SQLITE_PRAGMA and first.lower() not in ('foreign_keys', 'defer_foreign_keys', 'recursive_triggers'):
            return sqlite3.SQLITE_DENY
        if action == sqlite3.SQLITE_FUNCTION and (second or '').lower() in ('load_extension', 'writefile', 'readfile'):
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK
    db.set_authorizer(authorize)
    try:
        db.executescript(sql.decode('utf-8'))
        db.set_authorizer(None)
        return db
    except Exception:
        db.close()
        raise


def references(db):
    rows = db.execute('SELECT storage_key, hash, size FROM files UNION SELECT storage_key, hash, size FROM file_versions').fetchall()
    result = {}
    for row in rows:
        key, sha, size = row
        if key in result and result[key] != (sha, size):
            raise ValueError('A storage key has conflicting metadata')
        if not isinstance(sha, str) or len(sha) != 64 or any(c not in '0123456789abcdef' for c in sha) or size < 0:
            raise ValueError('Invalid object integrity metadata')
        result[key] = (sha, size)
    return result


def object_path(directory, key):
    # Vault paths and R2 keys never become local filesystem paths.
    return Path(directory) / 'objects' / digest(key.encode('utf-8'))


def verify(directory):
    directory = Path(directory)
    manifest = json.loads((directory / 'archive.json').read_text())
    if manifest.get('format') != 1 or manifest.get('complete') is not True:
        raise ValueError('Archive is incomplete or unsupported')
    sql = (directory / 'database.sql').read_bytes()
    if digest(sql) != manifest['databaseSha256']:
        raise ValueError('Database export checksum mismatch')
    db = load_database(sql)
    try:
        expected = references(db)
        objects = {item['key']: item for item in manifest['objects']}
        if len(objects) != len(manifest['objects']) or set(objects) != set(expected) | ({'__crate__/settings.json'} if '__crate__/settings.json' in objects else set()):
            raise ValueError('Archive object inventory does not match the database')
        for key, item in objects.items():
            data = object_path(directory, key).read_bytes()
            if digest(data) != item['sha256'] or len(data) != item['size']:
                raise ValueError('Archived object checksum mismatch')
            if key in expected and expected[key] != (item['sha256'], item['size']):
                raise ValueError('Archived object does not match its D1 reference')
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('Database integrity check failed')
        return manifest, db
    except Exception:
        db.close()
        raise


def prepare_restore_sql(directory, restored_at=None):
    """Rebuild derived schedules and require fresh device enrollment in a new deployment."""
    _manifest, db = verify(directory)
    try:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        for table in ('auth_tokens', 'push_subscriptions', 'push_enrollment_tokens', 'web_enrollment_tokens',
                      'scheduled_reminders', 'notification_jobs', 'reminder_projections', 'reminder_file_cache',
                      'object_cleanup_queue', 'request_rate_limits', 'notification_projection_jobs'):
            if table in tables:
                db.execute(f'DELETE FROM "{table}"')
        # Restored retained content gets a fresh recovery window before collection.
        restored_at = int(time.time() * 1000) if restored_at is None else restored_at
        db.execute('UPDATE file_versions SET expires_at = ?', (restored_at + 2592000000,))
        if 'notification_projection_jobs' in tables:
            db.execute("INSERT INTO notification_projection_jobs (path, job_token, updated_at) SELECT path, storage_key, datetime(? / 1000, 'unixepoch') FROM files WHERE lower(path) LIKE '%.md'", (restored_at,))
        db.commit()
        return '\n'.join(db.iterdump()).encode('utf-8')
    finally:
        db.close()


def database_contents(db):
    """Compare persisted application rows after import without logging private values."""
    tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")]
    contents = {}
    for name in tables:
        quoted = '"' + name.replace('"', '""') + '"'
        contents[name] = sorted((tuple(row) for row in db.execute('SELECT * FROM ' + quoted)), key=repr)
    return contents
