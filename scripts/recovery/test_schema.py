import hashlib
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from recovery import schema


class FutureSchemaTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        (root / 'migrations').mkdir()
        self.db = sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.db.executescript((schema.SOURCE / 'schema.sql').read_text())
        self.db.execute("INSERT INTO files(path, portable_path, storage_key) VALUES ('A.md', 'a.md', 'original')")
        self.db.commit()
        self.sql = 'CREATE TABLE example(id TEXT PRIMARY KEY);'
        self.step = dict(id='add-example', file='add-example.sql', **{'from': 1, 'to': 2}, checksum=hashlib.sha256(self.sql.encode()).hexdigest())
        (root / 'migrations/add-example.sql').write_text(self.sql)
        (root / 'server-release.json').write_text(json.dumps(dict(revision=2, schemaVersion=2, minimumSchemaVersion=1, migrations=[self.step])))
        self.root = root
        self.patch = patch.object(schema, 'SOURCE', root)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def test_future_upgrade_preserves_files_and_repeats_without_running_old_steps(self):
        schema.upgrade_schema(self.db)
        schema.upgrade_schema(self.db)
        self.assertEqual(schema.validate_schema(self.db), 2)
        self.assertEqual(self.db.execute('SELECT path, storage_key FROM files').fetchone(), ('A.md', 'original'))
        self.assertEqual(self.db.execute('SELECT id, checksum FROM crate_migrations').fetchone(), (self.step['id'], self.step['checksum']))

    def test_fresh_future_install_needs_no_historical_receipts(self):
        self.db.execute('UPDATE crate_schema SET version = 2, created_version = 2')
        self.db.executescript(self.sql)
        self.assertEqual(schema.validate_schema(self.db), 2)
        schema.upgrade_schema(self.db)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM crate_migrations').fetchone()[0], 0)

    def test_modified_sql_and_missing_receipts_stop_without_guessing(self):
        (self.root / 'migrations/add-example.sql').write_text(self.sql + ' ')
        with self.assertRaisesRegex(ValueError, 'integrity'):
            schema.upgrade_schema(self.db)
        self.assertEqual(self.db.execute('SELECT version FROM crate_schema').fetchone()[0], 1)
        self.db.execute('UPDATE crate_schema SET version = 2')
        with self.assertRaisesRegex(ValueError, 'history'):
            schema.validate_schema(self.db)
