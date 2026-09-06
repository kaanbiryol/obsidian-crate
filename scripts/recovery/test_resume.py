import io
import json
import os
import unittest
import urllib.error
from unittest.mock import Mock, patch
import test_archive
from test_archive import Remote, recovery
from recovery.cloudflare import Cloudflare


class TransportTests(unittest.TestCase):
    def test_retry_after_is_honored_before_retrying_a_429(self):
        error = urllib.error.HTTPError('https://api.cloudflare.com/test', 429, 'limited', {'Retry-After': '2'}, io.BytesIO())
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = b'content'
        response.headers = {'Content-Type': 'text/plain'}
        opener = Mock()
        opener.open.side_effect = [error, response]
        with patch.dict(os.environ, {'CLOUDFLARE_API_TOKEN': 'fixture'}), patch('urllib.request.build_opener', return_value=opener), patch('time.sleep') as sleep:
            remote = Cloudflare('account', 'database', 'bucket')
            self.assertEqual(remote.get_object('key'), (b'content', 'text/plain'))
            sleep.assert_any_call(2)
        self.assertEqual(opener.open.call_count, 2)

    def test_d1_ingest_is_not_blindly_replayed_on_ambiguous_failure(self):
        error = urllib.error.HTTPError('https://api.cloudflare.com/test', 503, 'unavailable', {}, io.BytesIO())
        opener = Mock()
        opener.open.side_effect = error
        with patch.dict(os.environ, {'CLOUDFLARE_API_TOKEN': 'fixture'}), patch('urllib.request.build_opener', return_value=opener):
            remote = Cloudflare('account', 'database', 'bucket')
            with self.assertRaisesRegex(RuntimeError, '503'):
                remote.request('/d1/database/database/import', {'action': 'ingest'}, retry=False)
        self.assertEqual(opener.open.call_count, 1)

    def test_object_inventory_reads_all_cursor_pages(self):
        with patch.dict(os.environ, {'CLOUDFLARE_API_TOKEN': 'fixture'}):
            remote = Cloudflare('account', 'database', 'bucket')
        remote.request = Mock(side_effect=[
            {'result': [{'key': 'one'}], 'result_info': {'is_truncated': True, 'cursor': 'second'}},
            {'result': [{'key': 'two'}], 'result_info': {'is_truncated': False}},
        ])
        self.assertEqual(remote.list_object_keys(), {'one', 'two'})
        self.assertIn('cursor=second', remote.request.call_args.args[0])


class ResumeTests(unittest.TestCase):
    setUp = test_archive.ArchiveTests.setUp
    tearDown = test_archive.ArchiveTests.tearDown
    def target(self):
        remote = Remote(b'', {})
        remote.database, remote.bucket = 'restore', 'restore'
        return remote

    def test_restore_resumes_after_upload_succeeded_but_acknowledgement_was_lost(self):
        recovery.backup(self.remote, self.directory)
        target = self.target()
        original = target.put_object
        def lose_ack(key, data, content_type):
            original(key, data, content_type)
            raise RuntimeError('Lost upload acknowledgement')
        target.put_object = lose_ack
        with self.assertRaisesRegex(RuntimeError, 'Lost upload'):
            recovery.restore(target, self.directory)
        target.put_object = Mock(side_effect=AssertionError('Verified object must not be overwritten'))
        recovery.restore(target, self.directory)
        self.assertTrue(target.imported)
        self.assertEqual(target.objects, self.remote.objects)

    def test_restore_recognizes_a_committed_d1_import_after_its_acknowledgement_is_lost(self):
        recovery.backup(self.remote, self.directory)
        target = self.target()
        original = target.import_sql
        def lose_ack(sql, before_ingest, record_bookmark):
            original(sql, before_ingest, record_bookmark)
            raise RuntimeError('Lost import acknowledgement')
        target.import_sql = lose_ack
        with self.assertRaisesRegex(RuntimeError, 'Lost import'):
            recovery.restore(target, self.directory)
        target.import_sql = Mock(side_effect=AssertionError('Do not re-import a committed database'))
        recovery.restore(target, self.directory)
        self.assertTrue(target.imported)

    def test_import_upload_failure_can_resume_before_ingest_was_dispatched(self):
        recovery.backup(self.remote, self.directory)
        target = self.target()
        original = target.import_sql
        target.import_sql = Mock(side_effect=RuntimeError('SQL upload interrupted'))
        with self.assertRaisesRegex(RuntimeError, 'SQL upload'):
            recovery.restore(target, self.directory)
        target.import_sql = original
        recovery.restore(target, self.directory)
        self.assertTrue(target.imported)

    def test_unconfirmed_import_is_not_restarted_while_the_database_still_looks_empty(self):
        recovery.backup(self.remote, self.directory)
        target = self.target()
        def queued(sql, before_ingest, record_bookmark):
            before_ingest()
            raise RuntimeError('Lost ingest acknowledgement before publication')
        target.import_sql = queued
        with self.assertRaisesRegex(RuntimeError, 'Lost ingest'):
            recovery.restore(target, self.directory)
        target.import_sql = Mock(side_effect=AssertionError('Do not dispatch a second ingest'))
        with self.assertRaisesRegex(ValueError, 'unconfirmed'):
            recovery.restore(target, self.directory)

    def test_an_accepted_import_resumes_polling_its_recorded_bookmark(self):
        recovery.backup(self.remote, self.directory)
        target = self.target()
        def accepted(sql, before_ingest, record_bookmark):
            before_ingest()
            record_bookmark('accepted-import')
            target.resume_import = Mock(side_effect=lambda _bookmark: setattr(target, 'sql', sql))
            raise RuntimeError('Polling interrupted')
        target.import_sql = accepted
        with self.assertRaisesRegex(RuntimeError, 'Polling interrupted'):
            recovery.restore(target, self.directory)
        target.import_sql = Mock(side_effect=AssertionError('Resume the accepted job'))
        recovery.restore(target, self.directory)
        target.resume_import.assert_called_once_with('accepted-import')

    def test_resume_rejects_unexpected_objects_and_never_overwrites_changed_bytes(self):
        recovery.backup(self.remote, self.directory)
        target = self.target()
        target.put_object = Mock(side_effect=RuntimeError('offline'))
        with self.assertRaisesRegex(RuntimeError, 'offline'):
            recovery.restore(target, self.directory)
        target.objects['unrelated'] = b'unrelated'
        with self.assertRaisesRegex(ValueError, 'outside this archive'):
            recovery.restore(target, self.directory)
        del target.objects['unrelated']
        key = next(iter(self.remote.objects))
        target.objects[key] = b'changed'
        with self.assertRaisesRegex(ValueError, 'refusing to overwrite'):
            recovery.restore(target, self.directory)
        self.assertEqual(target.objects[key], b'changed')

    def test_resume_rejects_changed_checkpoint_identity(self):
        recovery.backup(self.remote, self.directory)
        target = self.target()
        target.put_object = Mock(side_effect=RuntimeError('offline'))
        with self.assertRaises(RuntimeError):
            recovery.restore(target, self.directory)
        checkpoint = next(self.directory.glob('restore-*.json'))
        state = json.loads(checkpoint.read_text())
        state['archive'] = 'another archive'
        checkpoint.write_text(json.dumps(state))
        with self.assertRaisesRegex(ValueError, 'does not match'):
            recovery.restore(target, self.directory)

    def test_backup_resume_keeps_its_pinned_export_and_verified_objects(self):
        original = self.remote.get_object
        def interrupt_settings(key):
            if key == '__crate__/settings.json':
                raise RuntimeError('offline')
            return original(key)
        self.remote.get_object = interrupt_settings
        with self.assertRaisesRegex(RuntimeError, 'offline'):
            recovery.backup(self.remote, self.directory)
        self.remote.export = Mock(side_effect=AssertionError('Do not change the export bookmark'))
        def only_settings(key):
            self.assertEqual(key, '__crate__/settings.json')
            return original(key)
        self.remote.get_object = only_settings
        manifest = recovery.backup(self.remote, self.directory)
        self.assertEqual(len(manifest['objects']), 1)
