"""The same release manifest and immutable SQL used by the plugin provisioner."""
import hashlib
import json
import re
from pathlib import Path

SOURCE = Path(__file__).parents[2] / 'src/cloudflare'


def release_plan():
    release = json.loads((SOURCE / 'server-release.json').read_text())
    current = 1
    seen = set()
    if type(release['minimumSchemaVersion']) is not int or not 1 <= release['minimumSchemaVersion'] <= release['schemaVersion']:
        raise ValueError('Invalid database release manifest')
    for step in release['migrations']:
        if (not re.fullmatch(r'[a-z0-9-]+', step['id']) or step['id'] in seen
                or step['from'] != current or step['to'] != current + 1
                or step['file'] != step['id'] + '.sql'
                or not re.fullmatch(r'[a-f0-9]{64}', step['checksum'])):
            raise ValueError('Invalid database migration chain')
        seen.add(step['id'])
        current = step['to']
    if current != release['schemaVersion']:
        raise ValueError('Missing database migration path')
    return release


def validate_schema(db):
    release = release_plan()
    rows = db.execute('SELECT id, version, created_version FROM crate_schema').fetchall()
    if (len(rows) != 1 or rows[0][0] != 1 or type(rows[0][1]) is not int
            or type(rows[0][2]) is not int
            or not 1 <= rows[0][2] <= rows[0][1]
            or not release['minimumSchemaVersion'] <= rows[0][1] <= release['schemaVersion']):
        raise ValueError('Unsupported Crate database schema')
    version = rows[0][1]
    expected = {(step['id'], step['checksum']) for step in release['migrations'] if rows[0][2] <= step['from'] and step['to'] <= version}
    if {tuple(row) for row in db.execute('SELECT id, checksum FROM crate_migrations')} != expected:
        raise ValueError('Database migration history does not match this build')
    return version


def upgrade_schema(db):
    version = validate_schema(db)
    for step in release_plan()['migrations']:
        if step['from'] < version:
            continue
        sql = (SOURCE / 'migrations' / step['file']).read_bytes()
        if hashlib.sha256(sql).hexdigest() != step['checksum']:
            raise ValueError('Database migration failed its integrity check')
        # This is an isolated in-memory copy; source archive bytes never change.
        db.executescript('BEGIN;\n' + sql.decode('utf-8') + '\n'
                         + f"INSERT INTO crate_migrations(id, checksum) VALUES ('{step['id']}', '{step['checksum']}');\n"
                         + f"UPDATE crate_schema SET version = {step['to']} WHERE id = 1;\nCOMMIT;")
    validate_schema(db)
