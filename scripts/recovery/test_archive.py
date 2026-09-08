import importlib.util
import json
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
    def database_is_empty(self):
        return not self.sql
    def list_object_keys(self):
        return set(self.objects)
    def import_sql(self, sql, before_ingest=lambda: None, record_bookmark=lambda _bookmark: None):
        before_ingest()
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
        db.execute("INSERT INTO reminder_sources (file_path, reminder_id, due_key, occurrences) VALUES ('Reminders/Inbox.md', 'reminder', '2026-09-07', 1)")
        db.execute("INSERT INTO reminder_occurrences (reminder_id, due_key, first_seen_at) VALUES ('reminder', '2026-09-07', 123)")
        db.execute("INSERT INTO file_deletion_receipts (consumed_revision, revision, changelog_seq, path, consumed_hash, request_id, device_id) VALUES ('consumed', 'deleted', 1, 'Deleted.md', 'hash', 'original-request', 'old-device')")
        db.execute("INSERT INTO maintenance_state (key, value) VALUES ('crate_deployment_fence', 'old deployment owner')")
        db.execute("INSERT INTO reminder_source_state (file_path, file_revision, parser_version, verified) VALUES ('Reminders/Inbox.md', ?, 6, 1)", (key,))
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
        for table in ('reminder_sources', 'reminder_occurrences', 'file_deletion_receipts'):
            self.assertEqual(restored.execute(f'SELECT * FROM {table}').fetchall(), original.execute(f'SELECT * FROM {table}').fetchall())
        self.assertEqual(restored.execute('SELECT COUNT(*) FROM notification_projection_jobs').fetchone()[0], 1)
        self.assertEqual(restored.execute("SELECT COUNT(*) FROM maintenance_state WHERE key = 'crate_deployment_fence'").fetchone()[0], 0)
        self.assertEqual(restored.execute('SELECT COUNT(*) FROM reminder_source_state').fetchone()[0], 0)
        self.assertEqual(len(manifest['objects']), 1)
    def test_schema_three_backup_restores_with_additive_source_verification_upgrade(self):
        self.remote.sql += b'\nDROP TABLE reminder_source_state; UPDATE crate_schema SET version = 3;'
        recovery.backup(self.remote, self.directory)
        target = Remote(b'', {})
        target.database, target.bucket = 'restore', 'restore'
        recovery.restore(target, self.directory)
        restored = load_database(target.sql)
        self.addCleanup(restored.close)
        self.assertEqual(restored.execute('SELECT version FROM crate_schema').fetchone()[0], 4)
        self.assertEqual(restored.execute('SELECT COUNT(*) FROM reminder_source_state').fetchone()[0], 0)
        self.assertEqual(restored.execute('SELECT first_seen_at FROM reminder_occurrences').fetchone()[0], 123)
        self.assertEqual(restored.execute('SELECT COUNT(*) FROM file_deletion_receipts').fetchone()[0], 1)
        self.assertEqual(self.remote.objects, target.objects)
    def test_schema_two_can_be_backed_up_before_upgrade_and_restores_without_rewriting_its_archive(self):
        self.remote.sql += b'\nDROP TABLE reminder_source_state; DROP TABLE file_deletion_receipts; UPDATE crate_schema SET version = 2;'
        recovery.backup(self.remote, self.directory)
        source_sql = (self.directory / 'database.sql').read_bytes()
        manifest_bytes = (self.directory / 'archive.json').read_bytes()
        _, original = verify(self.directory)
        self.addCleanup(original.close)
        self.assertEqual(original.execute('SELECT version FROM crate_schema').fetchone()[0], 2)
        target = Remote(b'', {})
        target.database, target.bucket = 'restore', 'restore'
        recovery.restore(target, self.directory)
        restored = load_database(target.sql)
        self.addCleanup(restored.close)
        self.assertEqual(restored.execute('SELECT version FROM crate_schema').fetchone()[0], 4)
        for table in ('files', 'file_versions', 'reminder_operations', 'reminder_identities', 'reminder_sources', 'reminder_occurrences'):
            self.assertEqual(restored.execute(f'SELECT * FROM {table}').fetchall(), original.execute(f'SELECT * FROM {table}').fetchall())
        self.assertEqual(restored.execute('SELECT COUNT(*) FROM file_deletion_receipts').fetchone()[0], 0)
        self.assertEqual(restored.execute('SELECT COUNT(*) FROM reminder_source_state').fetchone()[0], 0)
        self.assertEqual(target.objects, self.remote.objects)
        self.assertEqual((self.directory / 'database.sql').read_bytes(), source_sql)
        self.assertEqual((self.directory / 'archive.json').read_bytes(), manifest_bytes)
        # Repeating a completed restore recognizes the existing target exactly.
        recovery.restore(target, self.directory)
        self.assertEqual((self.directory / 'database.sql').read_bytes(), source_sql)
    def test_unsupported_schema_stops_restore_before_remote_mutation(self):
        recovery.backup(self.remote, self.directory)
        sql_path = self.directory / 'database.sql'
        sql = sql_path.read_bytes() + b"\nUPDATE crate_schema SET version = 999;"
        sql_path.write_bytes(sql)
        manifest_path = self.directory / 'archive.json'
        manifest = json.loads(manifest_path.read_text())
        manifest['databaseSha256'] = digest(sql)
        manifest_path.write_text(json.dumps(manifest))
        target = Remote(b'', {})
        target.database, target.bucket = 'restore', 'restore'
        with self.assertRaisesRegex(ValueError, 'Unsupported Crate database schema'):
            recovery.restore(target, self.directory)
        self.assertEqual(target.objects, {})
        self.assertFalse(target.imported)
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
