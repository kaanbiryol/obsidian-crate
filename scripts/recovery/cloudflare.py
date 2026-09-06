"""Cloudflare REST transport; tokens are never written to disk or logs."""
import hashlib
import http.client
import json
import os
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from email.utils import parsedate_to_datetime


def retry_delay(attempt, headers=None):
    value = headers.get('Retry-After') if headers else None
    if value:
        try:
            delay = float(value)
        except ValueError:
            try:
                delay = max(0, parsedate_to_datetime(value).timestamp() - time.time())
            except (ValueError, TypeError, OverflowError):
                return min(60, 2 ** attempt) + random.random()
        if not 0 <= delay <= 300:
            raise RuntimeError('Provider requested a longer pause; resume recovery later')
        return delay
    return min(60, 2 ** attempt) + random.random()


class NoCredentialRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, _request, _fp, _code, _message, _headers, _url):
        return None


class Cloudflare:
    def __init__(self, account, database, bucket):
        self.account, self.database, self.bucket = account, database, bucket
        self.token = os.environ['CLOUDFLARE_API_TOKEN']
        self.base = 'https://api.cloudflare.com/client/v4/accounts/' + urllib.parse.quote(account, safe='')
        self.db_path = '/d1/database/' + urllib.parse.quote(database, safe='')
        self.r2_path = '/r2/buckets/' + urllib.parse.quote(bucket, safe='') + '/objects'
        self.next_r2_request = 0

    def request(self, path, body=None, method=None, raw=False, content_type=None, envelope=False, retry=True):
        url = self.base + path
        data = body if isinstance(body, bytes) else json.dumps(body).encode() if body is not None else None
        headers = {'Authorization': 'Bearer ' + self.token}
        if data is not None:
            headers['Content-Type'] = content_type or 'application/json'
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        for attempt in range(8):
            if path.startswith(self.r2_path):
                # Leave headroom below the account's R2 REST limit; shared
                # traffic can still cause 429 and is handled by Retry-After.
                time.sleep(max(0, self.next_r2_request - time.monotonic()))
                self.next_r2_request = time.monotonic() + 0.3
            try:
                with urllib.request.build_opener(NoCredentialRedirect()).open(request, timeout=60) as response:
                    data = response.read()
                    if raw:
                        return data, response.headers.get('Content-Type', 'application/octet-stream')
                    break
            except urllib.error.HTTPError as error:
                status, headers = error.code, error.headers
                error.close()
                if retry and attempt < 7 and (status in (408, 429) or 500 <= status < 600):
                    time.sleep(retry_delay(attempt, headers))
                    continue
                # Do not include provider bodies, signed URLs, or file names.
                raise RuntimeError('Cloudflare request failed with HTTP ' + str(status)) from None
            except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.IncompleteRead):
                if not retry or attempt == 7:
                    raise RuntimeError('Cloudflare connection interrupted; resume recovery') from None
                time.sleep(retry_delay(attempt))
        value = json.loads(data)
        if value.get('success') is not True:
            raise RuntimeError('Cloudflare reported an unsuccessful request')
        return value if envelope else value['result']

    def export(self):
        payload = {'output_format': 'polling'}
        for _attempt in range(600):
            result = self.request(self.db_path + '/export', payload)
            if result.get('status') == 'error':
                raise RuntimeError('D1 export failed')
            if result.get('status') == 'complete':
                url = result['result']['signed_url']
                if urllib.parse.urlparse(url).scheme != 'https':
                    raise RuntimeError('Invalid export URL')
                with urllib.request.urlopen(url, timeout=120) as response:
                    return response.read(), result.get('at_bookmark')
            payload['current_bookmark'] = result['at_bookmark']
            time.sleep(1)
        raise RuntimeError('D1 export timed out; no complete archive was created')

    def object_route(self, key):
        if any(segment in ('', '.', '..') for segment in key.split('/')):
            raise ValueError('Noncanonical R2 object key')
        return self.r2_path + '/' + urllib.parse.quote(key, safe='/')

    def get_object(self, key):
        return self.request(self.object_route(key), raw=True)

    def put_object(self, key, data, content_type):
        self.request(self.object_route(key), data, 'PUT', content_type=content_type)

    def database_is_empty(self):
        result = self.request(self.db_path + '/query', {'sql': "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"})
        if not isinstance(result, list) or not result or any(item.get('success') is not True or not isinstance(item.get('results'), list) for item in result):
            raise RuntimeError('Could not verify that the destination database is empty')
        return not any(item['results'] for item in result)

    def list_object_keys(self):
        keys, cursors, cursor = set(), set(), None
        while True:
            query = {'per_page': 1000}
            if cursor:
                query['cursor'] = cursor
            value = self.request(self.r2_path + '?' + urllib.parse.urlencode(query), envelope=True)
            objects, info = value['result'], value.get('result_info', {})
            if not isinstance(objects, list) or any(not isinstance(item.get('key'), str) for item in objects):
                raise RuntimeError('Could not verify the destination object inventory')
            keys.update(item['key'] for item in objects)
            if not info.get('is_truncated'):
                return keys
            cursor = info.get('cursor')
            if not isinstance(cursor, str) or not cursor or cursor in cursors:
                raise RuntimeError('Invalid destination inventory pagination')
            cursors.add(cursor)

    def require_empty(self):
        if not self.database_is_empty():
            raise RuntimeError('Restore requires a new empty D1 database')
        if self.list_object_keys():
            raise RuntimeError('Restore requires a new empty R2 bucket')

    def import_sql(self, sql, before_ingest=lambda: None, record_bookmark=lambda _bookmark: None):
        etag = hashlib.md5(sql).hexdigest()  # Cloudflare import protocol requires MD5.
        initialized = self.request(self.db_path + '/import', {'action': 'init', 'etag': etag})
        upload_url = initialized.get('upload_url')
        if upload_url:
            if urllib.parse.urlparse(upload_url).scheme != 'https':
                raise RuntimeError('Invalid import URL')
            with urllib.request.urlopen(urllib.request.Request(upload_url, data=sql, method='PUT'), timeout=120) as response:
                if response.status >= 400:
                    raise RuntimeError('Database upload failed')
        # Ingest may have committed despite a lost response. The restore
        # checkpoint verifies destination SQL before deciding whether to retry.
        before_ingest()
        result = self.request(self.db_path + '/import', {'action': 'ingest', 'etag': etag, 'filename': initialized['filename']}, retry=False)
        self.wait_import(result, record_bookmark)

    def resume_import(self, bookmark):
        self.wait_import(self.request(self.db_path + '/import', {'action': 'poll', 'current_bookmark': bookmark}), lambda _bookmark: None)

    def wait_import(self, result, record_bookmark):
        for _attempt in range(600):
            if result.get('at_bookmark'):
                record_bookmark(result['at_bookmark'])
            if result.get('status') == 'complete':
                return
            if result.get('status') == 'error':
                raise RuntimeError('Database import failed; keep the target deployment offline')
            time.sleep(1)
            result = self.request(self.db_path + '/import', {'action': 'poll', 'current_bookmark': result['at_bookmark']})
        raise RuntimeError('Database import timed out; keep the target deployment offline')
