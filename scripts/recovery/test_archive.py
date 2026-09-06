import importlib.util
import sqlite3
import tempfile
import unittest
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parents[1]))
from recovery.archive import digest, verify, load_database, references, object_path

spec = importlib.util.spec_from_file_location('crate_recovery', Path(__file__).parents[1] / 'crate-recovery.py')
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


class Remote:
    account, database, bucket = 'test', 'source', 'source'
    def __init__(self, sql, objects):
        self.sql, self.objects = sql, objects
        self.imported = False
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
    def import_sql(self, sql):
        self.sql, self.imported = sql, True


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name) / 'backup'
        db = sqlite3.connect(':memory:')
        db.executescript((Path(__file__).parents[2] / 'src/cloudflare/schema.sql').read_text())
        data = b'only vault copy\x00\xff'
        key = '__crate__/files/' + digest(data) + '/test'
        db.execute('INSERT INTO files (path, portable_path, hash, size, storage_key) VALUES (?, ?, ?, ?, ?)',
                   ('Reminders/Inbox.md', 'reminders/inbox.md', digest(data), len(data), key))
        db.execute("INSERT INTO auth_tokens (id, token_hash) VALUES ('old-device', 'hash')")
        db.execute("INSERT INTO reminder_operations (operation_id, request_hash, response_json) VALUES ('retry-me', 'hash', '{}')")
        db.commit()
        self.remote = Remote('\n'.join(db.iterdump()).encode(), {key: data})
        db.close()
    def tearDown(self):
        self.temp.cleanup()
    def test_paired_restore_preserves_bytes_and_receipts_and_resets_derived_state(self):
        recovery.backup(self.remote, self.directory)
        manifest, original = verify(self.directory)
        self.addCleanup(original.close)
        target = Remote(b'', {})
        target.database, target.bucket = 'restore', 'restore'
        recovery.restore(target, self.directory)
        restored = load_database(target.sql)
        self.addCleanup(restored.close)
        self.assertEqual(references(original), references(restored))
        self.assertEqual(self.remote.objects, target.objects)
        self.assertEqual(restored.execute('SELECT COUNT(*) FROM auth_tokens').fetchone()[0], 0)
        self.assertEqual(restored.execute('SELECT COUNT(*) FROM reminder_operations').fetchone()[0], 1)
        self.assertEqual(restored.execute('SELECT COUNT(*) FROM notification_projection_jobs').fetchone()[0], 1)
        self.assertEqual(len(manifest['objects']), 1)
    def test_corrupt_object_stops_restore_before_remote_mutation(self):
        recovery.backup(self.remote, self.directory)
        key = next(iter(self.remote.objects))
        object_path(self.directory, key).write_bytes(b'corrupt')
        target = Remote(b'', {})
        target.database, target.bucket = 'restore', 'restore'
        with self.assertRaises(ValueError):
            recovery.restore(target, self.directory)
        self.assertEqual(target.objects, {})
        self.assertFalse(target.imported)
    def test_missing_source_object_leaves_no_complete_archive(self):
        self.remote.objects = {}
        with self.assertRaises(RuntimeError):
            recovery.backup(self.remote, self.directory)
        self.assertFalse((self.directory / 'archive.json').exists())
    def test_refuses_source_or_nonempty_restore_target(self):
        recovery.backup(self.remote, self.directory)
        with self.assertRaises(ValueError):
            recovery.restore(self.remote, self.directory)
        target = Remote(b'existing', {})
        target.database, target.bucket = 'restore', 'restore'
        with self.assertRaises(RuntimeError):
            recovery.restore(target, self.directory)
        self.assertFalse(target.imported)
    def test_export_sql_cannot_attach_an_external_database(self):
        with self.assertRaises(sqlite3.DatabaseError):
            load_database(b"ATTACH DATABASE '/tmp/crate-unwanted.db' AS other;")


if __name__ == '__main__':
    unittest.main()
