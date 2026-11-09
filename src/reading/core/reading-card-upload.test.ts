import { expect, it } from 'vitest';
import { createVaultKeyBundle } from '@/encryption/key-bundle';
import { importEncryptionSecret } from '@/encryption/envelope';
import { deriveReadingSearchKey, hashedQueryTerms } from '@/encryption/reading-search';
import { createReadingNote } from './notes';
import { openReadingCard, validateReadingCardData } from './reading-card';
import { readingUploadCard } from './reading-card-upload';

it('attaches a card to Reading notes only, and never blocks an upload', async () => {
	const bundle = await createVaultKeyBundle();
	const keys = { vaultId: bundle.vaultId, key: await importEncryptionSecret(bundle.vault), keyGeneration: 1, searchKey: await deriveReadingSearchKey(bundle.vaultId, bundle.vault) };
	const note = new TextEncoder().encode(createReadingNote({ id: '00000000-0000-4000-8000-000000000001', url: 'https://example.com/a', title: 'Card title', savedAt: '2026-01-01T00:00:00.000Z' }));
	const data = await readingUploadCard('Reading', 'Reading/Card.md', 'tag/card.md', note, keys);
	validateReadingCardData(data);
	expect(data.fields).toEqual({ item_id: '00000000-0000-4000-8000-000000000001', saved_at: '2026-01-01T00:00:00.000Z', status: 'inbox', favorite: false, highlighted: false });
	expect((await openReadingCard(data.card, 'tag/card.md', keys)).item).toMatchObject({ title: 'Card title', path: 'Reading/Card.md' });
	// The card is bound to its server path.
	await expect(openReadingCard(data.card, 'tag/other.md', keys)).rejects.toThrow();
	expect((await hashedQueryTerms(keys.searchKey, { q: 'card' })).every(term => data.terms.includes(term))).toBe(true);
	for (const [folder, path, bytes] of [['Reading', 'Elsewhere/Card.md', note], [null, 'Reading/Card.md', note], ['Reading', 'Reading/Plain.md', new TextEncoder().encode('# Not a Reading note')],
		['Reading', 'Reading/Broken.md', new Uint8Array([0xff, 0xfe])], ['Reading', 'Reading/Card.md', new Uint8Array(1024 * 1024 + 1)]] as const) {
		expect(await readingUploadCard(folder, path, 'tag/x.md', bytes, keys)).toBeNull();
	}
});
