/**
 * Frozen `descriptor` column values: the packed encrypted file descriptors that the Worker
 * stores in `files`, `changelog` and `file_versions` rows. Stored rows must keep reading
 * back the exact descriptor they were packed from, and packing it again must give the
 * same bytes.
 *
 * Fixtures in `__fixtures__/` are append-only. To freeze a new packed format, append an
 * entry below with a new file name (for example `descriptor-column.v2.json`), then run
 * `CRATE_WRITE_FIXTURES=descriptor-column.v2.json npx vitest run src/cloudflare/worker/encryption/descriptor-column.fixtures.test.ts`.
 * Only the missing file is written; review and commit it. Never edit or regenerate an
 * existing fixture. See `src/test/frozen-fixtures.ts`.
 */
import { describe } from 'vitest';
import { testFrozenFixtures } from '@/test/frozen-fixtures';
import { generateEncryptionSecret, importEncryptionSecret } from '../../../encryption/envelope';
import { sealFile } from '../../../encryption/file-codec';
import { packDescriptor, unpackDescriptor } from './descriptor-column';

const vaultId = '263d20c2-de47-459a-b603-973181a5b6d4';
const sealed = async (path: string) => (await sealFile({ path, content: new TextEncoder().encode('# Fixture') },
	{ vaultId, scopeId: 'vault', key: await importEncryptionSecret(generateEncryptionSecret()) })).descriptor;
const decode = (stored: string) => unpackDescriptor(stored);
const canonical = (stored: string) => packDescriptor(unpackDescriptor(stored));

describe('frozen descriptor columns', () => {
	testFrozenFixtures(new URL('./__fixtures__/', import.meta.url), [
		{ file: 'descriptor-column.v1.json', decode, canonical, stored: async () => packDescriptor(await sealed('Notes/Fixture.md')) },
		// A descriptor packing cannot rebuild exactly is stored as its JSON.
		{ file: 'descriptor-column.json-fallback.json', decode, canonical, stored: async () => packDescriptor({ ...await sealed('Notes/Fixture.md'), keyId: 'fixture-key' }) },
	]);
});
