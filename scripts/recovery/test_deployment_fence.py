import importlib.util
import json
import sqlite3
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parents[1]))
spec = importlib.util.spec_from_file_location('deployment_fence', Path(__file__).parents[1] / 'crate-deployment-fence.py')
fence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fence)


class Remote:
    db_path = '/d1/database/test'

    def __init__(self):
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        self.db.execute('CREATE TABLE maintenance_state (key TEXT PRIMARY KEY, value TEXT)')
        self.calls = []
        self.before_delete = lambda: None

    def request(self, _path, body, retry):
        self.calls.append(body['sql'])
        if body['sql'].startswith('DELETE'):
            self.before_delete()
        return [{'success': True, 'results': [dict(row) for row in self.db.execute(body['sql'], body['params'])]}]


class FenceTests(unittest.TestCase):
    def setUp(self):
        self.remote = Remote()
        self.addCleanup(self.remote.db.close)
        self.worker = 'crate-' + 'a' * 16
        self.owner = '11111111-1111-4111-8111-111111111111'
        self.record = {'worker': self.worker, 'owner': self.owner, 'kind': 'reset', 'version': '0.1.0'}
        self.remote.db.execute('INSERT INTO maintenance_state VALUES (?, ?)', (fence.KEY, json.dumps(self.record)))

    def test_requires_quiescence_and_the_exact_inspected_owner(self):
        with self.assertRaises(ValueError):
            fence.release(self.remote, self.worker, self.owner)
        with self.assertRaises(ValueError):
            fence.release(self.remote, self.worker, 'different', True)
        self.assertFalse(any(sql.startswith('DELETE') for sql in self.remote.calls))
        self.assertTrue(fence.release(self.remote, self.worker, self.owner, True))
        self.assertIsNone(fence.inspect(self.remote, self.worker))

    def test_conditional_release_cannot_clear_a_new_owner(self):
        newer = dict(self.record, owner='22222222-2222-4222-8222-222222222222')
        self.remote.before_delete = lambda: self.remote.db.execute('UPDATE maintenance_state SET value = ?', (json.dumps(newer),))
        with self.assertRaises(ValueError):
            fence.release(self.remote, self.worker, self.owner, True)
        self.assertEqual(fence.inspect(self.remote, self.worker)[1], newer)

    def test_refuses_a_different_worker(self):
        with self.assertRaises(ValueError):
            fence.release(self.remote, 'crate-' + 'b' * 16, self.owner, True)
        self.assertEqual(fence.inspect(self.remote, self.worker)[1], self.record)


if __name__ == '__main__':
    unittest.main()
