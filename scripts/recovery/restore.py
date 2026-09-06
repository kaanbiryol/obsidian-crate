"""Resume a verified archive into the same isolated destination after interruption."""
import json
import time
from contextlib import closing
from pathlib import Path
from .archive import database_contents, digest, load_database, object_path, prepare_restore_sql, verify
from .checkpoint import identity, save


def restore(remote, directory):
    directory = Path(directory)
    manifest, verified_db = verify(directory)
    verified_db.close()
    source, target = manifest['source'], identity(remote)
    if remote.account == source['account'] and (remote.database == source['database'] or remote.bucket == source['bucket']):
        raise ValueError('Restore cannot target either source resource')
    archive_hash = digest((directory / 'archive.json').read_bytes())
    checkpoint = directory / ('restore-' + digest(json.dumps(target, sort_keys=True).encode()) + '.json')
    if checkpoint.exists():
        state = json.loads(checkpoint.read_text())
        if state.get('format') != 1 or state.get('archive') != archive_hash or state.get('target') != target:
            raise ValueError('Restore checkpoint does not match this archive and destination')
        if state.get('phase') not in ('objects', 'importing', 'complete') or type(state.get('restoredAt')) is not int:
            raise ValueError('Invalid restore checkpoint')
    else:
        remote.require_empty()
        state = {'format': 1, 'archive': archive_hash, 'target': target,
                 'phase': 'objects', 'restoredAt': int(time.time() * 1000)}
        save(checkpoint, state)

    sql = prepare_restore_sql(directory, state['restoredAt'])
    allowed = {item['key'] for item in manifest['objects']}
    if not remote.list_object_keys() <= allowed:
        raise ValueError('Restore target contains objects outside this archive')
    if state['phase'] == 'importing' and state.get('importBookmark'):
        remote.resume_import(state['importBookmark'])
    empty = remote.database_is_empty()
    if empty and state['phase'] == 'importing':
        # Empty does not prove a previously dispatched import was rejected: it
        # may still be queued. Never start a second import on that assumption.
        raise ValueError('Earlier database import is unconfirmed; wait and resume later, keeping the target offline')
    if not empty:
        if state['phase'] == 'objects':
            raise ValueError('Restore database was changed before the recorded import')
        restored_sql, _bookmark = remote.export()
        with closing(load_database(restored_sql)) as actual, closing(load_database(sql)) as expected:
            if database_contents(actual) != database_contents(expected):
                raise ValueError('Restore database differs from the checkpoint; keep it offline')
    elif state['phase'] == 'complete':
        raise ValueError('Previously restored database is now empty')

    for index, item in enumerate(manifest['objects'], 1):
        try:
            uploaded, _type = remote.get_object(item['key'])
        except RuntimeError as error:
            if str(error) != 'Cloudflare request failed with HTTP 404':
                raise
            if not empty:
                raise ValueError('Published restore is missing an object; keep it offline') from None
            data = object_path(directory, item['key']).read_bytes()
            remote.put_object(item['key'], data, item.get('contentType', 'application/octet-stream'))
            uploaded, _type = remote.get_object(item['key'])
        if digest(uploaded) != item['sha256'] or len(uploaded) != item['size']:
            raise ValueError('Destination object differs from the archive; refusing to overwrite it')
        if index % 100 == 0:
            print(f'Verified {index} destination objects', flush=True)

    if empty:
        def before_ingest():
            state['phase'] = 'importing'
            save(checkpoint, state)
        def record_bookmark(bookmark):
            state['importBookmark'] = bookmark
            save(checkpoint, state)
        remote.import_sql(sql, before_ingest, record_bookmark)
        restored_sql, _bookmark = remote.export()
        with closing(load_database(restored_sql)) as actual, closing(load_database(sql)) as expected:
            if database_contents(actual) != database_contents(expected):
                raise ValueError('Restored database contents differ; keep the target offline')
    state['phase'] = 'complete'
    save(checkpoint, state)
