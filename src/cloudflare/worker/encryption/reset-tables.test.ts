import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import restorePolicy from '../../restore/restore-policy.json';
import { ENCRYPTION_RESET_TABLES, WIPED_TABLE_KEYS } from './reset-tables';

const schema = readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8');
const tables = [...schema.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/g)].map(match => match[1]!).sort();

describe('table policies cover the schema', () => {
	it('classifies every table for an encryption reset exactly once', () => {
		const listed = Object.values(ENCRYPTION_RESET_TABLES).flat();
		expect(new Set(listed).size).toBe(listed.length);
		// A new table holding vault data must not survive a reset unnoticed: list it under wiped, custom or kept.
		expect([...listed].sort()).toEqual(tables);
	});

	it('names each wiped table by its primary key', () => {
		for (const table of ENCRYPTION_RESET_TABLES.wiped) {
			const body = new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?${table}\\s*\\(([\\s\\S]*?)\\n?\\)\\s*(?:WITHOUT ROWID)?;`).exec(schema)?.[1] ?? '';
			const key = /PRIMARY KEY\s*\(([^)]*)\)/.exec(body)?.[1] ?? /(?:^|[(,])\s*(\w+)[^,]*?PRIMARY KEY/m.exec(body)?.[1];
			expect(WIPED_TABLE_KEYS[table], table).toBe(key?.split(',').map(column => column.trim()).join(', '));
		}
	});

	it('names only existing tables in the restore policy', () => {
		for (const table of [...restorePolicy.resetTables, ...Object.keys(restorePolicy.resetColumns)]) expect(tables).toContain(table);
	});
});
