/**
 * Frozen upload retry journal records (`pending-uploads/<operation>.json`) as
 * released plugins wrote them before dispatching an upload. After an upgrade the
 * plugin must still load them and resend the exact same bytes and operation ID.
 *
 * Fixtures in `__fixtures__/` are append-only. To freeze a new version, append an
 * entry below with a new file name (for example `upload-journal-local.v2.json`), then run
 * `CRATE_WRITE_FIXTURES=upload-journal-local.v2.json npx vitest run src/sync/durability/upload-journal.fixtures.test.ts`.
 * Only the missing file is written; review and commit it. Never edit or
 * regenerate an existing fixture. See `src/test/frozen-fixtures.ts`.
 */
import { describe } from 'vitest';
import { testFrozenFixtures } from '@/test/frozen-fixtures';
import { PersistentTestVault, TEST_PLUGIN_DIR } from '@/test/factories/sync-vault';
import { sha256Hex } from '@/platform/sha256';
import { UploadJournal } from './upload-journal';
import { mergeUploadIntent, uploadWire, type IntendedUpload } from './upload-intent';

const directory = `${TEST_PLUGIN_DIR}/pending-uploads`;
const authority = 'https://crate.example.test';
const bytes = (text: string) => new TextEncoder().encode(text).buffer;

async function record(file: IntendedUpload): Promise<string> {
	const disk = new PersistentTestVault();
	const journal = new UploadJournal(disk.vault.adapter, directory, authority);
	const [prepared] = await journal.prepare([file], 20757, '33333333-3333-4333-8333-333333333333');
	await journal.close();
	return disk.text(`${directory}/${prepared!.operationId}.json`);
}

async function load(saved: string) {
	const disk = new PersistentTestVault();
	const { file } = JSON.parse(saved) as { file: { operationId: string } };
	await disk.vault.adapter.mkdir(directory);
	await disk.vault.adapter.write(`${directory}/${file.operationId}.json`, saved);
	const journal = new UploadJournal(disk.vault.adapter, directory, authority);
	await journal.load();
	// What a retry sends: the journal entry and its exact wire request.
	return journal.pending().map(entry => ({ entry, wire: uploadWire(entry) }));
}

async function upload(text: string, operationId: string, expectedHash: string | null): Promise<IntendedUpload> {
	return { operationId, path: 'Notes/hello.md', content: btoa(text), hash: await sha256Hex(text), size: bytes(text).byteLength,
		contentType: 'text/markdown', expectedHash, intent: { kind: 'local' } };
}

describe('frozen upload journal records', () => {
	testFrozenFixtures(new URL('./__fixtures__/', import.meta.url), [
		{
			// A new local file, uploaded with an absent-file precondition.
			file: 'upload-journal-local.v1.json',
			stored: async () => record(await upload('Hello from protocol 1', 'e1_00020757_11111111-1111-4111-8111-111111111111', null)),
			decode: load,
		},
		{
			// A merge result that keeps the remote preimage it was merged against.
			file: 'upload-journal-merge.v1.json',
			stored: async () => record({
				...await upload('Merged line one\nMerged line two\n', 'e1_00020757_22222222-1111-4111-8111-111111111111', await sha256Hex('Merged line one\n')),
				intent: await mergeUploadIntent(bytes('Merged line one\n')),
			}),
			decode: load,
		},
	]);
});
