import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkLocalUpgrade } from '../src/local-server-backup.mjs';
import { assertLocalMigrationPath, migrateLocalDatabase } from '../src/local-server-migrations.mjs';
import { issueLocalDevice, openLocalRuntime } from '../src/local-server-runtime.mjs';

const release = JSON.parse(await readFile(new URL('../../../src/cloudflare/server-release.json', import.meta.url), 'utf8'));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const step = (id, sql, from = release.schemaVersion) => ({ id, from, to: from + 1, file: `${id}.sql`, checksum: sha256(sql) });
const upgradeTo = (...migrations) => ({ ...release, schemaVersion: release.schemaVersion + migrations.length, migrations });
const rows = async (db, sql) => (await db.prepare(sql).all()).results;
const counts = db => db.prepare('SELECT (SELECT count(*) FROM auth_tokens) AS tokens, (SELECT count(*) FROM files) AS files, (SELECT count(*) FROM file_versions) AS versions').first();
// The trigger body and the quoted literal both contain ';', which statement splitting broke.
const fixtureSql = `CREATE TABLE fixture_notes (id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE fixture_log (id TEXT NOT NULL);
CREATE TRIGGER fixture_notes_logged AFTER INSERT ON fixture_notes BEGIN
	INSERT INTO fixture_log(id) VALUES (NEW.id);
END;
INSERT INTO fixture_notes(id, body) VALUES ('seed', 'keeps; semicolons');
`;

async function seed(db) {
	await issueLocalDevice(db, 'Upgrade test');
	await db.prepare("INSERT INTO files(path, portable_path, hash, size, storage_key) VALUES ('Note.md', 'note.md', 'hash', 5, 'current')").run();
	await db.prepare("INSERT INTO file_versions(storage_key, path, hash, size, reason, expires_at) VALUES ('previous', 'Note.md', 'old', 3, 'replaced', ?)").bind(Date.now() + 60_000).run();
	return counts(db);
}

test('upgrades a real data directory across a fixture migration run as one script', { timeout: 60_000 }, async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'crate-migration-test-'));
	let runtime;
	try {
		runtime = await openLocalRuntime({ dataDir, administrative: true });
		assert.equal(JSON.parse(await readFile(join(dataDir, 'server.json'), 'utf8')).schemaVersion, release.schemaVersion);
		const before = await seed(runtime.db);
		const migration = step('add-fixture-notes', fixtureSql);
		const target = upgradeTo(migration);
		const read = [];
		await migrateLocalDatabase(runtime.db, target, async file => { read.push(file); return fixtureSql; });
		assert.deepEqual(read, [migration.file]);
		assert.deepEqual(await runtime.db.prepare('SELECT version, created_version FROM crate_schema').first(), { version: target.schemaVersion, created_version: release.schemaVersion });
		assert.deepEqual(await rows(runtime.db, 'SELECT id, checksum FROM crate_migrations'), [{ id: migration.id, checksum: migration.checksum }]);
		assert.deepEqual(await counts(runtime.db), before);
		assert.deepEqual(await rows(runtime.db, 'SELECT body FROM fixture_notes'), [{ body: 'keeps; semicolons' }]);
		assert.deepEqual(await rows(runtime.db, 'SELECT id FROM fixture_log'), [{ id: 'seed' }]);
		await migrateLocalDatabase(runtime.db, target, () => assert.fail('A completed migration must not run again.'));
		await assert.rejects(migrateLocalDatabase(runtime.db, upgradeTo({ ...migration, checksum: sha256('edited') }), async () => fixtureSql), /history does not match/);
		await runtime.close(); runtime = null;
		// The committed marker persisted, so this build refuses the newer database.
		await assert.rejects(openLocalRuntime({ dataDir, administrative: true }), /Unsupported local database schema/);
	} finally { await runtime?.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('a failed or unverified fixture migration leaves the local database unchanged', { timeout: 60_000 }, async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'crate-migration-test-'));
	let runtime;
	try {
		runtime = await openLocalRuntime({ dataDir, administrative: true });
		const before = await seed(runtime.db);
		const failing = `CREATE TABLE fixture_partial (id TEXT);
INSERT INTO files(path, portable_path, storage_key) VALUES ('Extra.md', 'extra.md', 'extra');
INSERT INTO fixture_missing VALUES (1);`;
		const migration = step('add-partial', failing);
		await assert.rejects(migrateLocalDatabase(runtime.db, upgradeTo(migration), async () => failing), /fixture_missing/);
		await assert.rejects(migrateLocalDatabase(runtime.db, upgradeTo(migration), async () => `${failing}\n`), /integrity check/);
		// Manifest checks the previous local runner skipped: duplicate IDs and non-hex checksums.
		const duplicate = step('add-partial', failing, release.schemaVersion + 1);
		for (const target of [upgradeTo(migration, duplicate), upgradeTo({ ...migration, checksum: migration.checksum.toUpperCase() })]) {
			await assert.rejects(migrateLocalDatabase(runtime.db, target, async () => failing), /Invalid database migration chain/);
		}
		assert.deepEqual(await runtime.db.prepare('SELECT version, created_version FROM crate_schema').first(), { version: release.schemaVersion, created_version: release.schemaVersion });
		assert.deepEqual(await rows(runtime.db, 'SELECT id FROM crate_migrations'), []);
		assert.equal(await runtime.db.prepare("SELECT name FROM sqlite_master WHERE name = 'fixture_partial'").first(), null);
		assert.deepEqual(await counts(runtime.db), before);
		await runtime.close(); runtime = null;
		// This build registers no migration from the recorded version, so a changed hash stays blocked.
		const metadataPath = join(dataDir, 'server.json');
		const changed = JSON.stringify({ ...JSON.parse(await readFile(metadataPath, 'utf8')), schemaHash: 'changed-schema' });
		await writeFile(metadataPath, changed);
		await assert.rejects(checkLocalUpgrade(dataDir), /No tested migration/);
		assert.equal(await readFile(metadataPath, 'utf8'), changed);
	} finally { await runtime?.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('a changed local schema needs an older recorded version with a registered migration', () => {
	const target = upgradeTo(step('add-fixture-notes', fixtureSql));
	assert.doesNotThrow(() => assertLocalMigrationPath(release.schemaVersion, target));
	for (const version of [undefined, String(release.schemaVersion), target.schemaVersion, target.schemaVersion + 1]) {
		assert.throws(() => assertLocalMigrationPath(version, target), /No tested migration/);
	}
	assert.throws(() => assertLocalMigrationPath(release.schemaVersion, release), /No tested migration/);
	assert.throws(() => assertLocalMigrationPath(0, target), /Unsupported database schema/);
});
