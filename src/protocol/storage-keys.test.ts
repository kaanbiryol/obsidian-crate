import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	createManagedObjectKey,
	HISTORY_CHECKPOINT_OBJECT,
	HISTORY_INDEX_KEY,
	isGeneratedCrateObjectKey,
	MANAGED_FILE_OBJECT,
	SHARED_SETTINGS_KEY,
	UPGRADE_BACKUP_OBJECT,
} from './storage-keys';

const hash = 'a'.repeat(64);
const uuid = '00000000-0000-4000-8000-000000000001';

describe('Crate storage keys', () => {
	it('matches the keys Crate generates', () => {
		expect(isGeneratedCrateObjectKey(createManagedObjectKey(hash))).toBe(true);
		expect(isGeneratedCrateObjectKey(`__crate__/backups/schema-upgrade-${uuid}/database.sql`)).toBe(true);
		expect(isGeneratedCrateObjectKey(`__crate__/history/checkpoints/${uuid}.json`)).toBe(true);
		expect(isGeneratedCrateObjectKey(SHARED_SETTINGS_KEY)).toBe(true);
		expect(isGeneratedCrateObjectKey(HISTORY_INDEX_KEY)).toBe(true);
	});

	it.each([
		'notes/user-file.md',
		`__crate__/files/${hash}/custom`,
		`__crate__/files/${hash.toUpperCase()}/${uuid}`,
		`__crate__/backups/other-${uuid}/database.sql`,
		`__crate__/history/checkpoints/${uuid}.json.bak`,
	])('does not claim unrecognized key %j', key => {
		expect(isGeneratedCrateObjectKey(key)).toBe(false);
	});

	// The retirement Worker is uploaded verbatim and cannot import this module.
	it('keeps the embedded reset worker patterns identical', () => {
		const source = readFileSync(new URL('../cloudflare/worker/standalone/reset-worker.js', import.meta.url), 'utf8');
		const embedded = (name: string) => new RegExp(`const ${name} = /(.+)/;`).exec(source)?.[1];
		expect(embedded('managedObject')).toBe(MANAGED_FILE_OBJECT.source);
		expect(embedded('upgradeBackupObject')).toBe(UPGRADE_BACKUP_OBJECT.source);
		expect(embedded('historyCheckpointObject')).toBe(HISTORY_CHECKPOINT_OBJECT.source);
		expect(source).toContain(`key !== '${SHARED_SETTINGS_KEY}' && key !== '${HISTORY_INDEX_KEY}'`);
	});
});
