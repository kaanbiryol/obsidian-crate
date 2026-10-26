import release from '../server-release.json';
import { sha256Hex } from '../../platform/sha256';
import * as rules from './database-upgrade-rules';
import type { DatabaseMigration, DatabaseRelease } from './database-upgrade-rules';

export type { DatabaseMigration, DatabaseRelease };

export const SERVER_RELEASE: DatabaseRelease = release;

// Migration SQL is bundled locally, never fetched or evaluated from a remote source.
// Glob keys are module-relative paths, so index the SQL by manifest file name.
const sources = new Map(Object.entries(import.meta.glob<string>('../migrations/*.sql', { query: '?raw', import: 'default', eager: true }))
	.map(([path, sql]): [string, string] => [path.slice(path.lastIndexOf('/') + 1), sql]));

export function planDatabaseUpgrade(version: number | null, target: DatabaseRelease = SERVER_RELEASE): DatabaseMigration[] {
	return rules.planDatabaseUpgrade(version, target);
}

export function validateMigrationHistory(version: number, createdVersion: unknown, receipts: readonly Record<string, unknown>[], target: DatabaseRelease = SERVER_RELEASE): void {
	rules.validateMigrationHistory(version, createdVersion, receipts, target);
}

export async function migrationTransaction(migration: DatabaseMigration, sql = sources.get(migration.file)): Promise<string> {
	if (!sql || await sha256Hex(sql) !== migration.checksum) throw new Error('Database migration failed its integrity check');
	return rules.migrationTransactionSql(migration, sql);
}
