/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import currentSchema from '../schema.sql?raw';
import { inspectDeploymentDatabase, prepareDeploymentDatabase } from './database';
import { migrationTransaction, SERVER_RELEASE, validateMigrationHistory } from './database-upgrades';
import type { DeploymentFence } from './fence';
import { sha256Hex } from '../../platform/sha256';

// Guardrails for registered migrations, run through the provisioner's real runner.
// `__fixtures__/schema-<n>.sql` freezes the schema a server created at version n has, and
// `schema-<n>-rows.sql` synthetic rows in it. Raising `minimumSchemaVersion` needs both files
// for the new floor. Never edit a frozen schema to make these tests pass: a mismatch means a
// server created at that version would not end up with `schema.sql`.

/** D1 Free plan row writes per day. One update runs every pending migration on the same day. */
const FREE_PLAN_DAILY_ROW_WRITES = 100_000;
/** All migrations from the oldest supported schema together, leaving the day for sync and backup. */
const UPGRADE_ROW_WRITE_BUDGET = 10_000;
const LARGE_TABLE_ROWS = 100_000;

const fixtures = import.meta.glob<string>('./__fixtures__/schema-*.sql', { query: '?raw', import: 'default', eager: true });
const fixture = (file: string) => {
	const sql = fixtures[`./__fixtures__/${file}`];
	if (sql === undefined) throw new Error(`Freeze __fixtures__/${file} for minimumSchemaVersion ${SERVER_RELEASE.minimumSchemaVersion}`);
	return sql;
};
const oldestSchema = () => fixture(`schema-${SERVER_RELEASE.minimumSchemaVersion}.sql`);
const oldestRows = () => fixture(`schema-${SERVER_RELEASE.minimumSchemaVersion}-rows.sql`);

afterEach(reset);

/**
 * Splits a script into statements like the D1 query API, keeping trigger bodies and quoted
 * semicolons intact. A batch then runs it as one transaction and reports each statement's
 * row writes, which a single multi-statement query does not.
 */
function statements(sql: string): string[] {
	const result: string[] = [];
	let start = 0, depth = 0, trigger = false;
	for (let i = 0; i < sql.length; i++) {
		const char = sql[i]!;
		if (char === "'" || char === '"' || char === '`') i = sql.indexOf(char, i + 1) < 0 ? sql.length : sql.indexOf(char, i + 1);
		else if (char === '-' && sql[i + 1] === '-') i = sql.indexOf('\n', i) < 0 ? sql.length : sql.indexOf('\n', i);
		else if (char === '/' && sql[i + 1] === '*') i = sql.indexOf('*/', i) < 0 ? sql.length : sql.indexOf('*/', i) + 1;
		else if (/[A-Za-z_]/.test(char) && !/[\w$]/.test(sql[i - 1] ?? '')) {
			const word = /^[\w$]+/.exec(sql.slice(i))![0].toUpperCase();
			if (word === 'TRIGGER' && /^\s*CREATE\s+(TEMP\s+|TEMPORARY\s+)?$/i.test(stripComments(sql.slice(start, i)))) trigger = true;
			if ((word === 'BEGIN' && trigger) || word === 'CASE') depth++;
			if (word === 'END' && depth > 0) depth--;
			i += word.length - 1;
		} else if (char === ';' && depth === 0) {
			result.push(sql.slice(start, i));
			start = i + 1;
			trigger = false;
		}
	}
	result.push(sql.slice(start));
	return result.filter(statement => stripComments(statement).trim());
}
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

interface StatementResult { results?: Record<string, unknown>[]; meta: { rows_written: number } }
async function runScript(db: D1Database, sql: string): Promise<StatementResult[]> {
	const batch = statements(sql).map(statement => db.prepare(statement));
	return batch.length ? db.batch<StatementResult>(batch) : [];
}

const rowsWritten = (results: StatementResult[]) => results.reduce((sum, result) => sum + result.meta.rows_written, 0);

/** Applies every pending registered migration through the provisioner, counting row writes per step. */
async function upgradeOldestDatabase(db: D1Database) {
	const writes: Record<string, number> = {};
	let current = '';
	const api = { queryD1: async (_account: string, _database: string, sql: string) => {
		const results = await runScript(db, sql);
		if (current) writes[current] = (writes[current] ?? 0) + rowsWritten(results);
		return results;
	} };
	const fence = {
		mutate: async <T>(operation: () => Promise<T>, step: string): Promise<T> => {
			current = step;
			try { return await operation(); } finally { current = ''; }
		},
		requireVerification: () => {},
	} as unknown as DeploymentFence;
	const artifacts = { version: '0.0.0', fingerprint: 'f'.repeat(64), workerBundle: '', workerBundleSha256: '', d1Schema: currentSchema, d1SchemaSha256: await sha256Hex(currentSchema) };
	const input = { api, accountId: 'account', databaseId: 'database', artifacts };
	const version = await inspectDeploymentDatabase(input);
	expect(version).toBe(SERVER_RELEASE.minimumSchemaVersion);
	// The provisioner calls this after a verified D1/R2 checkpoint, which these tests do not need.
	await prepareDeploymentDatabase(input, version, fence, async () => {});
	return writes;
}

const all = async (db: D1Database, sql: string, ...values: unknown[]) => (await db.prepare(sql).bind(...values).all<Record<string, unknown>>()).results;
const normalize = (sql: string) => stripComments(sql).replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').trim();

/** Every CHECK constraint of a CREATE TABLE statement, wherever it is declared. */
function checks(sql: string): string[] {
	const text = normalize(sql), found: string[] = [];
	for (const match of text.matchAll(/\bCHECK\(/gi)) {
		let depth = 0, end = match.index + match[0].length - 1;
		for (; end < text.length; end++) {
			if (text[end] === '(') depth++;
			else if (text[end] === ')' && --depth === 0) break;
		}
		found.push(text.slice(match.index + match[0].length, end));
	}
	return found.sort();
}

/** The persisted shape of a database, ignoring upgrade write guards and Cloudflare's own tables. */
async function describeSchema(db: D1Database) {
	const objects = await all(db, String.raw`SELECT type, name, tbl_name, sql FROM sqlite_master
		WHERE name NOT LIKE 'sqlite\_%' ESCAPE '\' AND name NOT LIKE '\_cf\_%' ESCAPE '\' AND name NOT LIKE 'crate\_upgrade\_%' ESCAPE '\'
		ORDER BY type, name`);
	const shape: Record<string, unknown> = {};
	for (const object of objects) {
		const name = String(object.name);
		if (object.type !== 'table') {
			shape[`${String(object.type)} ${name}`] = { table: object.tbl_name, sql: normalize(String(object.sql)) };
			continue;
		}
		const indexes = await all(db, 'SELECT name, "unique", origin, partial FROM pragma_index_list(?) ORDER BY name', name);
		shape[`table ${name}`] = {
			kind: await all(db, 'SELECT type, wr, strict FROM pragma_table_list(?)', name),
			columns: await all(db, 'SELECT cid, name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid', name),
			checks: checks(String(object.sql)),
			foreignKeys: await all(db, 'SELECT id, seq, "table", "from", "to", on_update, on_delete, "match" FROM pragma_foreign_key_list(?) ORDER BY id, seq', name),
			indexes: await Promise.all(indexes.map(async index => ({
				...index, columns: await all(db, 'SELECT seqno, cid, name, "desc", coll, "key" FROM pragma_index_xinfo(?) ORDER BY seqno', index.name),
			}))),
		};
	}
	return shape;
}

const tableNames = async (db: D1Database) => (await all(db, String.raw`SELECT name FROM sqlite_master WHERE type = 'table'
	AND name NOT LIKE 'sqlite\_%' ESCAPE '\' AND name NOT LIKE '\_cf\_%' ESCAPE '\'`)).map(row => String(row.name));

it('migrates the oldest supported schema to exactly the fresh schema, keeping its rows', async () => {
	await runScript(env.DB, currentSchema);
	const fresh = await describeSchema(env.DB);
	const freshColumns = new Map(await Promise.all((await tableNames(env.DB)).map(async table =>
		[table, (await all(env.DB, 'SELECT name FROM pragma_table_info(?)', table)).map(row => String(row.name))] as const)));
	await reset();

	await runScript(env.DB, oldestSchema());
	await runScript(env.DB, oldestRows());
	// Schema markers and receipts are rewritten by design. Every other row must survive.
	const seeded = (await tableNames(env.DB)).filter(table => table !== 'crate_schema' && table !== 'crate_migrations');
	const before = new Map(await Promise.all(seeded.map(async table => [table, await all(env.DB, `SELECT * FROM "${table}"`)] as const)));
	expect([...before.values()].reduce((sum, rows) => sum + rows.length, 0)).toBeGreaterThan(20);

	await upgradeOldestDatabase(env.DB);

	const marker = await env.DB.prepare('SELECT version, created_version FROM crate_schema WHERE id = 1').first();
	expect(marker).toEqual({ version: SERVER_RELEASE.schemaVersion, created_version: SERVER_RELEASE.minimumSchemaVersion });
	validateMigrationHistory(SERVER_RELEASE.schemaVersion, marker!.created_version, await all(env.DB, 'SELECT id, checksum FROM crate_migrations'));
	expect(await describeSchema(env.DB)).toEqual(fresh);
	const sorted = (rows: Record<string, unknown>[]) => rows.map(row => JSON.stringify(row)).sort();
	for (const [table, rows] of before) {
		const columns = (freshColumns.get(table) ?? []).filter(column => column in (rows[0] ?? {}));
		if (!rows.length || !columns.length) continue;
		const project = (row: Record<string, unknown>) => Object.fromEntries(columns.map(column => [column, row[column]]));
		const after = await all(env.DB, `SELECT ${columns.map(column => `"${column}"`).join(', ')} FROM "${table}"`);
		expect(sorted(after), table).toEqual(sorted(rows.map(project)));
	}
});

/** A large synthetic vault in the oldest supported schema: every large table at LARGE_TABLE_ROWS. */
async function seedLargeVault(db: D1Database) {
	const rows = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${LARGE_TABLE_ROWS})`;
	const writes = await runScript(db, `
		${rows} INSERT INTO files(path, portable_path, hash, size, storage_key) SELECT 'Notes/' || i || '.md', 'notes/' || i || '.md', 'hash-' || i, i, 'objects/' || i FROM n;
		${rows} INSERT INTO file_versions(storage_key, path, hash, size, reason, kept_at) SELECT 'versions/' || i, 'Notes/' || i || '.md', 'old-' || i, i, 'replaced', 1790000000000 FROM n;
		${rows} INSERT INTO changelog(seq, path, action, revision, hash, size) SELECT i, 'Notes/' || i || '.md', 'put', 'rev-' || i, 'hash-' || i, i FROM n;
		${rows} INSERT INTO note_terms(term, saved_at, portable_path) SELECT 'term-' || (i % 1000), '2026-01-01T00:00:00Z', 'reading/' || i || '.md' FROM n;
		${rows} INSERT INTO highlight_index(highlighted_at, portable_path, terms) SELECT '2026-01-01T00:00:00Z', 'reading/' || i || '.md', '[]' FROM n;`);
	return rowsWritten(writes);
}

it('keeps every registered migration within the row-write budget of a large vault', async () => {
	expect(UPGRADE_ROW_WRITE_BUDGET).toBeLessThan(FREE_PLAN_DAILY_ROW_WRITES / 5);
	await runScript(env.DB, oldestSchema());
	await seedLargeVault(env.DB);
	const writes = await upgradeOldestDatabase(env.DB);
	const steps = Object.keys(writes).filter(step => step.startsWith('migrate-'));
	expect(steps).toEqual(SERVER_RELEASE.migrations.filter(migration => migration.from >= SERVER_RELEASE.minimumSchemaVersion).map(migration => `migrate-${migration.id}`));
	const total = Object.values(writes).reduce((sum, count) => sum + count, 0);
	expect(total, `Row writes by step: ${JSON.stringify(writes)}. Change large tables through a resumable Worker backfill (docs/server-upgrades.md).`)
		.toBeLessThanOrEqual(UPGRADE_ROW_WRITE_BUDGET);
});

it('counts the row writes of a migration that rewrites a large table', async () => {
	await runScript(env.DB, oldestSchema());
	expect(await seedLargeVault(env.DB)).toBeGreaterThanOrEqual(5 * LARGE_TABLE_ROWS);
	const sql = 'CREATE INDEX files_hash_idx ON files(hash);\nUPDATE file_versions SET size = size + 1;';
	const from = SERVER_RELEASE.minimumSchemaVersion;
	const migration = { id: 'rewrite-large-tables', from, to: from + 1, file: 'rewrite-large-tables.sql', checksum: await sha256Hex(sql) };
	const results = await runScript(env.DB, await migrationTransaction(migration, sql));
	expect(rowsWritten(results)).toBeGreaterThan(UPGRADE_ROW_WRITE_BUDGET);
});
