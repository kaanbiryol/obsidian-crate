import { decodeBase64Url } from './encoding';
import type { EncryptionSecret } from './envelope';
import { encodeBase32 } from '../protocol/encrypted-path';
import { MAX_QUERY_WORDS, normalizedTag, readingTerms, searchWords, wordTerm } from '../reading/core/search-terms';
import { readingUrlIdentity } from '../reading/core/model';

/** Derives the key that hashes Reading search terms. Only clients holding the vault key can. */
export async function deriveReadingSearchKey(vaultId: string, secret: EncryptionSecret): Promise<CryptoKey> {
	const raw = decodeBase64Url(secret.secret, 32);
	try {
		const material = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
		return await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(vaultId),
			info: new TextEncoder().encode('crate-e2ee-v1/reading-search') }, material, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
	} finally { raw.fill(0); }
}

/** A term's server form: 60 bits of its HMAC, as 12 base32 characters. */
async function hashReadingTerm(key: CryptoKey, term: string): Promise<string> {
	const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`crate-reading-term-v1\0${term}`));
	return encodeBase32(new Uint8Array(mac, 0, 8)).slice(0, 12);
}

export const isHashedReadingTerm = (value: unknown): value is string => typeof value === 'string' && /^[a-z2-7]{12}$/.test(value);

/** The hashed terms a device stores with a note's card. */
export async function hashedReadingTerms(key: CryptoKey, item: Parameters<typeof readingTerms>[0]): Promise<string[]> {
	return [...new Set(await Promise.all(readingTerms(item).map(term => hashReadingTerm(key, term))))];
}

/** The hashed terms a query sends: a word of 3 or more letters matches by its first 3, a
 * shorter one exactly, so the device rechecks the titles it decrypts. The server starts from
 * whichever term has the fewest notes. */
export async function hashedQueryTerms(key: CryptoKey, query: { q?: string; tag?: string; url?: string }): Promise<string[]> {
	const words = searchWords(query.q ?? '', MAX_QUERY_WORDS).sort((a, b) => [...b].length - [...a].length);
	const terms = [...query.url ? [`u:${readingUrlIdentity(query.url)}`] : [], ...query.tag ? [`t:${normalizedTag(query.tag)}`] : [], ...words.map(wordTerm)];
	return [...new Set(await Promise.all(terms.map(term => hashReadingTerm(key, term))))];
}
