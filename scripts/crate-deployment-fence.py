#!/usr/bin/env python3
"""Inspect or release a stopped Crate deployment. Read docs/deployment.md first."""
import argparse
import json
import re
import sys
from recovery.cloudflare import Cloudflare

KEY = 'crate_deployment_fence'


def query(remote, sql, params):
    results = remote.request(remote.db_path + '/query', {'sql': sql, 'params': params}, retry=False)
    if not isinstance(results, list) or not results or any(item.get('success') is not True or not isinstance(item.get('results'), list) for item in results):
        raise ValueError('Could not verify the deployment fence query')
    return [row for result in results for row in result['results']]


def inspect(remote, worker):
    tables = query(remote, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'maintenance_state'", [])
    if not tables:
        return None
    rows = query(remote, 'SELECT value FROM maintenance_state WHERE key = ?', [KEY])
    if not rows:
        return None
    if len(rows) != 1 or not isinstance(rows[0].get('value'), str):
        raise ValueError('Invalid deployment fence')
    value = rows[0]['value']
    record = json.loads(value)
    if (not isinstance(record, dict) or record.get('worker') != worker
            or not re.fullmatch(r'crate-[a-f0-9]{16}', worker)
            or not re.fullmatch(r'[a-f0-9-]{36}', str(record.get('owner', '')))
            or record.get('kind') not in ('update', 'reset', 'delete')):
        raise ValueError('The deployment fence does not match the requested Worker')
    return value, record


def release(remote, worker, owner, confirm_quiescent=False):
    if not confirm_quiescent:
        raise ValueError('Stop all deployment/reset clients, revoke old credentials, and resolve in-flight requests before releasing the fence')
    current = inspect(remote, worker)
    if current is None:
        return False
    value, record = current
    if owner != record['owner']:
        raise ValueError('The owner changed; inspect the fence again')
    removed = query(remote, 'DELETE FROM maintenance_state WHERE key = ? AND value = ? RETURNING key', [KEY, value])
    if removed != [{'key': KEY}]:
        raise ValueError('The fence changed before release; no replacement owner was cleared')
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['inspect', 'release'])
    parser.add_argument('--account', required=True)
    parser.add_argument('--database', required=True)
    parser.add_argument('--worker', required=True)
    parser.add_argument('--owner')
    parser.add_argument('--confirm-quiescent', action='store_true')
    args = parser.parse_args()
    remote = Cloudflare(args.account, args.database, '')
    if args.action == 'inspect':
        current = inspect(remote, args.worker)
        if current is None:
            print('No deployment fence is held.')
        else:
            record = current[1]
            print(json.dumps({key: record.get(key) for key in ('owner', 'worker', 'kind', 'version', 'fingerprint', 'startedAt')}, indent=2))
    else:
        if not args.owner:
            parser.error('--owner from the inspection is required')
        changed = release(remote, args.worker, args.owner, args.confirm_quiescent)
        print('Released the inspected owner. Resume the original operation in Obsidian.' if changed else 'No fence is held. Review the live deployment before resuming.')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'Deployment fence recovery stopped ({type(error).__name__}). Keep the existing fence until the deployment and in-flight requests have been reviewed.', file=sys.stderr)
        sys.exit(1)
