import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import restorePolicy from '../../restore/restore-policy.json';
import { ENCRYPTION_RESET_TABLES } from './reset-tables';

const schema = readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8');
const tables = [...schema.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/g)].map(match => match[1]!).sort();

describe('table policies cover the schema', () => {
	it('classifies every table for an encryption reset exactly once', () => {
		const listed = Object.values(ENCRYPTION_RESET_TABLES).flat();
		expect(new Set(listed).size).toBe(listed.length);
		// A new table holding vault data must not survive a reset unnoticed: list it under wiped, custom or kept.
		expect([...listed].sort()).toEqual(tables);
	});

	it('names only existing tables in the restore policy', () => {
		for (const table of [...restorePolicy.resetTables, ...Object.keys(restorePolicy.resetColumns)]) expect(tables).toContain(table);
	});
});
