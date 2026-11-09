import { expect, it } from 'vitest';
import { createVaultKeyBundle } from './key-bundle';
import { deriveReadingSearchKey, hashedQueryTerms, hashedReadingTerms, isHashedReadingTerm } from './reading-search';

it('hashes the same terms for a note and a query that matches it, and different ones per vault', async () => {
	const [first, second] = await Promise.all([createVaultKeyBundle(), createVaultKeyBundle()]);
	const key = await deriveReadingSearchKey(first.vaultId, first.vault), other = await deriveReadingSearchKey(second.vaultId, second.vault);
	const note = { title: 'Learning JavaScript', tags: ['Code'], source_url: 'https://example.com/a#part' };
	const stored = await hashedReadingTerms(key, note);
	expect(stored.every(isHashedReadingTerm)).toBe(true);
	for (const query of [{ q: 'javas' }, { q: 'learning' }, { q: 'le' }, { tag: 'code' }, { url: 'https://example.com/a' }]) {
		const terms = await hashedQueryTerms(key, query);
		expect(terms.every(term => stored.includes(term)), JSON.stringify(query)).toBe(query.q !== 'le');
	}
	expect((await hashedQueryTerms(other, { q: 'javas' })).some(term => stored.includes(term))).toBe(false);
});
