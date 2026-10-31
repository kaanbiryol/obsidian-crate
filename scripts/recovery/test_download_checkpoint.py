import importlib.util
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parents[1]))
from recovery.archive import digest, load_database, references, verify
from recovery.download_checkpoint import STORE, download_checkpoint

spec = importlib.util.spec_from_file_location('crate_recovery', Path(__file__).parents[1] / 'crate-recovery.py')
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)

PREFIX = '__crate__/backups/schema-upgrade-11111111-2222-4333-8444-555555555555'


class Remote:
    def __init__(self, account, database, bucket, objects=None, sql=b''):
        self.account, self.database, self.bucket = account, database, bucket
        self.objects, self.sql, self.imported = objects or {}, sql, False
    def export(self):
        return self.sql, 'test-bookmark'
    def get_object(self, key):
        if key not in self.objects:
            raise RuntimeError('Cloudflare request failed with HTTP 404')
        return self.objects[key], 'application/octet-stream'
    def put_object(self, key, data, _type):
        self.objects[key] = data
    def require_empty(self):
        if self.sql or self.objects:
            raise RuntimeError('Target not empty')
    def database_is_empty(self):
        return not self.sql
    def list_object_keys(self):
        return set(self.objects)
    def import_sql(self, sql, before_ingest=lambda: None, record_bookmark=lambda _bookmark: None):
        before_ingest()
        self.sql, self.imported = sql, True


class DownloadCheckpointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        db = sqlite3.connect(':memory:')
        db.executescript((Path(__file__).parents[2] / 'src/cloudflare/schema.sql').read_text())
        self.files = {'__crate__/files/' + digest(data) + '/' + name: data for name, data in (('live', b'live note'), ('old', b'old note\x00\xff'))}
        live, old = self.files
        db.execute('INSERT INTO files (path, portable_path, hash, size, storage_key) VALUES (?, ?, ?, ?, ?)', ('Note.md', 'note.md', digest(self.files[live]), len(self.files[live]), live))
        db.execute('INSERT INTO file_versions (storage_key, path, hash, size, reason, expires_at) VALUES (?, ?, ?, ?, ?, ?)', (old, 'Note.md', digest(self.files[old]), len(self.files[old]), 'replaced', 1))
        db.execute("INSERT INTO maintenance_state (key, value) VALUES ('crate_upgrade_backup', '{\"format\":2,\"phase\":\"dumping\"}')")
        db.commit()
        self.sql = '\n'.join(db.iterdump()).encode()
        db.close()
        self.settings = b'{"setting":true}'
        self.remote = Remote('account', 'source', 'bucket')
        self.objects = [{'key': key, 'sha256': digest(data), 'size': len(data), 'contentType': 'application/octet-stream'} for key, data in sorted(self.files.items())]
        self.objects.insert(0, {'key': '__crate__/settings.json', 'sha256': digest(self.settings), 'size': len(self.settings), 'contentType': 'application/json'})
    def tearDown(self):
        self.temp.cleanup()

    def manifest(self, **fields):
        return json.dumps({'complete': True, 'createdAt': '2026-10-29T10:00:00.000Z', 'bookmark': None, 'objects': self.objects,
                           'source': {'account': 'account', 'database': 'source', 'bucket': 'bucket'}, **fields}).encode()

    def parted_checkpoint(self):
        """Database parts end at statement boundaries; file copies are shared and named by checksum."""
        middle = self.sql.index(b'\n', len(self.sql) // 2) + 1
        parts = [self.sql[:middle], self.sql[middle:]]
        for part in parts:
            self.remote.objects[PREFIX + '/objects/' + digest(part)] = part
        for data in [self.settings, *self.files.values()]:
            self.remote.objects[STORE + '/objects/' + digest(data)] = data
        self.remote.objects[PREFIX + '/archive.json'] = self.manifest(format=2, databaseParts=[{'sha256': digest(part), 'size': len(part)} for part in parts])

    def assert_restorable(self):
        directory = Path(self.temp.name) / 'checkpoint'
        manifest = download_checkpoint(self.remote, directory, PREFIX)
        self.assertEqual(manifest['format'], 1)
        self.assertEqual((directory / 'database.sql').read_bytes(), self.sql)
        _, archived = verify(directory)
        self.addCleanup(archived.close)
        target = Remote('account', 'restore', 'restore')
        recovery.restore(target, directory)
        restored = load_database(target.sql)
        self.addCleanup(restored.close)
        self.assertEqual(references(restored), references(archived))
        self.assertEqual({key: data for key, data in target.objects.items() if key in self.files}, self.files)
        self.assertEqual(target.objects['__crate__/settings.json'], self.settings)
        self.assertIsNone(restored.execute("SELECT value FROM maintenance_state WHERE key = 'crate_upgrade_backup'").fetchone())

    def test_downloads_parted_checkpoints_with_shared_file_copies(self):
        self.parted_checkpoint()
        self.assert_restorable()

    def test_rejects_corrupt_database_parts_and_the_shared_store_prefix(self):
        self.parted_checkpoint()
        manifest = json.loads(self.remote.objects[PREFIX + '/archive.json'])
        self.remote.objects[PREFIX + '/objects/' + manifest['databaseParts'][1]['sha256']] = b'DROP TABLE files;'
        with self.assertRaisesRegex(ValueError, 'database checksum'):
            download_checkpoint(self.remote, Path(self.temp.name) / 'corrupt', PREFIX)
        with self.assertRaisesRegex(ValueError, 'Invalid upgrade checkpoint prefix'):
            download_checkpoint(self.remote, Path(self.temp.name) / 'store', STORE)


if __name__ == '__main__':
    unittest.main()
