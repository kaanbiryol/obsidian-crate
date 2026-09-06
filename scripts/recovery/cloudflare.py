"""Cloudflare REST transport; tokens are never written to disk or logs."""
import hashlib
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request


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

    def request(self, path, body=None, method=None, raw=False, content_type=None):
        url = self.base + path
        data = body if isinstance(body, bytes) else json.dumps(body).encode() if body is not None else None
        headers = {'Authorization': 'Bearer ' + self.token}
        if data is not None:
            headers['Content-Type'] = content_type or 'application/json'
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.build_opener(NoCredentialRedirect()).open(request, timeout=60) as response:
                data = response.read()
                if raw:
                    return data, response.headers.get('Content-Type', 'application/octet-stream')
        except urllib.error.HTTPError as error:
            # Do not include provider bodies, signed URLs, or user file names.
            raise RuntimeError('Cloudflare request failed with HTTP ' + str(error.code)) from None
        value = json.loads(data)
        if value.get('success') is not True:
            raise RuntimeError('Cloudflare reported an unsuccessful request')
        return value['result']

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

    def require_empty(self):
        result = self.request(self.db_path + '/query', {'sql': "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"})
        if not isinstance(result, list) or not result or any(item.get('success') is not True or not isinstance(item.get('results'), list) for item in result):
            raise RuntimeError('Could not verify that the destination database is empty')
        if any(item['results'] for item in result):
            raise RuntimeError('Restore requires a new empty D1 database')
        objects = self.request(self.r2_path + '?per_page=1')
        if isinstance(objects, dict) and isinstance(objects.get('objects'), list):
            objects = objects['objects']
        if not isinstance(objects, list):
            raise RuntimeError('Could not verify that the destination bucket is empty')
        if objects:
            raise RuntimeError('Restore requires a new empty R2 bucket')

    def import_sql(self, sql):
        etag = hashlib.md5(sql).hexdigest()  # Cloudflare import protocol requires MD5.
        initialized = self.request(self.db_path + '/import', {'action': 'init', 'etag': etag})
        upload_url = initialized.get('upload_url')
        if upload_url:
            if urllib.parse.urlparse(upload_url).scheme != 'https':
                raise RuntimeError('Invalid import URL')
            with urllib.request.urlopen(urllib.request.Request(upload_url, data=sql, method='PUT'), timeout=120) as response:
                if response.status >= 400:
                    raise RuntimeError('Database upload failed')
        result = self.request(self.db_path + '/import', {'action': 'ingest', 'etag': etag, 'filename': initialized['filename']})
        for _attempt in range(600):
            if result.get('status') == 'complete':
                return
            if result.get('status') == 'error':
                raise RuntimeError('Database import failed; keep the target deployment offline')
            time.sleep(1)
            result = self.request(self.db_path + '/import', {'action': 'poll', 'current_bookmark': result['at_bookmark']})
        raise RuntimeError('Database import timed out; keep the target deployment offline')
