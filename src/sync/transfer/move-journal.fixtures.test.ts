/**
 * Frozen server move journals (`pending-moves.json`) as the plugin writes them before it
 * sends a move. After an upgrade the plugin must still read them and resend the same moves.
 *
 * Fixtures in `__fixtures__/` are append-only. To freeze a new version, append an entry
 * below with a new file name (for example `move-journal.v2.json`), then run
 * `CRATE_WRITE_FIXTURES=move-journal.v2.json npx vitest run src/sync/transfer/move-journal.fixtures.test.ts`.
 * Only the missing file is written; review and commit it. Never edit or regenerate an
 * existing fixture. See `src/test/frozen-fixtures.ts`.
 */
import { describe, expect, it } from 'vitest';
import { testFrozenFixtures } from '@/test/frozen-fixtures';
import { PersistentTestVault, TEST_PLUGIN_DIR } from '@/test/factories/sync-vault';
import { MoveJournal } from './move-journal';

const path = `${TEST_PLUGIN_DIR}/pending-moves.json`;
const authority = 'https://crate.example.test';
const moves = [
	{ from: 'Inbox/idea.md', to: 'Archive/idea.md', expectedHash: 'a'.repeat(64), expectedRevision: '__crate__/files/aaaa/11111111-1111-4111-8111-111111111111' },
	{ from: 'Inbox/photo.png', to: 'Archive/photo.png', expectedHash: 'b'.repeat(64), expectedRevision: '__crate__/files/bbbb/22222222-2222-4222-8222-222222222222' },
];

async function load(saved: string, reader = authority) {
	const disk = new PersistentTestVault();
	await disk.vault.adapter.write(path, saved);
	return new MoveJournal(disk.vault.adapter, path, reader).pending();
}

describe('move journal fixtures', () => {
	testFrozenFixtures(new URL('./__fixtures__/', import.meta.url), [{
		file: 'move-journal.v1.json',
		stored: async () => {
			const disk = new PersistentTestVault();
			await new MoveJournal(disk.vault.adapter, path, authority).record(moves);
			return disk.text(path);
		},
		decode: (saved: string) => load(saved),
	}]);
});

describe('MoveJournal', () => {
	it('reads no moves from a torn record, another server, or none at all', async () => {
		const disk = new PersistentTestVault();
		const journal = new MoveJournal(disk.vault.adapter, path, authority);
		expect(await journal.pending()).toEqual([]);
		await journal.record(moves);
		expect(await journal.pending()).toEqual(moves);
		expect(await new MoveJournal(disk.vault.adapter, path, 'https://other.example.test').pending()).toEqual([]);
		await disk.vault.adapter.write(path, '{"version":1,"auth');
		expect(await journal.pending()).toEqual([]);
		await journal.clear();
		expect(disk.has(path)).toBe(false);
	});

	it('refuses a journal it cannot interpret instead of dropping its moves', async () => {
		await expect(load(JSON.stringify({ version: 2, authority, moves }))).rejects.toThrow('Unsupported move journal');
		await expect(load(JSON.stringify({ version: 1, authority, moves: [{ from: 'a.md' }] }))).rejects.toThrow('Damaged move journal');
	});
});
