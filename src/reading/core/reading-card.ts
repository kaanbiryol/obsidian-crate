import { decryptJson, encryptJson, type EncryptionKey } from '@/encryption/envelope';
import { hashedHighlightTerms, hashedReadingTerms, hashedTagTerm, isHashedReadingTerm } from '@/encryption/reading-search';
import { sha256Hex } from '@/platform/sha256';
import { validateReadingMetadata, type ReadingItem } from './model';
import { highlightedAt, MAX_HIGHLIGHT_TERMS, normalizedTag } from './search-terms';

/**
 * An encrypted vault's listed item for one note revision. The device that encrypts a Reading
 * note attaches it to the note's upload as the file's public data (`readingCardData`), like a
 * reminder note's schedules, and the server lists the note from it in the same commit. The
 * server stores the envelope, the plaintext list fields and the hashed terms; it cannot read
 * the card.
 */
export interface ReadingCardKeys { vaultId: string; key: EncryptionKey; keyGeneration: number }
/** `wire` is the note's server path and `hash` its authenticated plaintext hash; the item
 * carries its plaintext path. */
interface CardBody { format: 1; wire: string; hash: string; item: ReadingItem }
/** What the server sorts and filters by. A device that reads a card checks them. */
export interface ReadingCardFields { item_id: string; saved_at: string; status: ReadingItem['reading_status']; favorite: boolean; highlighted: boolean }
/** A tag's sealed name, keyed by its hashed term, so a device can list every tag. */
export interface ReadingTagName { term: string; name: string }
/** A Reading note's public data, including what the Highlights tab and the tag list need:
 * when the note was last highlighted, its hashed highlight search terms and its sealed tag names. */
export interface ReadingCardData { kind: 'reading-card'; version: 1; card: string; terms: string[]; fields: ReadingCardFields; highlighted_at: string | null; highlight_terms: string[]; tag_names: ReadingTagName[] }

const MAX_CARD_TERMS = 400;
const MAX_CARD_TAGS = 50;
const MAX_TAG_NAME_CHARACTERS = 1024;
const MAX_CARD_CHARACTERS = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// The object ID binds the envelope to its server path, so the server cannot list one note's card as another.
const cardObject = async (wire: string, prefix: string) => `${prefix}-${(await sha256Hex(wire)).slice(0, 32)}`;
const context = async (keys: ReadingCardKeys, wire: string) => ({ vaultId: keys.vaultId, scopeId: 'vault', purpose: 'reading-card' as const,
	objectId: await cardObject(wire, `reading-card-${keys.keyGeneration}`) });

const readingCardFields = (item: ReadingItem): ReadingCardFields => ({ item_id: item.crate_reading_id, saved_at: item.saved_at,
	status: item.reading_status, favorite: item.favorite, highlighted: !!item.highlights?.length });

async function sealReadingCard(item: ReadingItem, wire: string, hash: string, keys: ReadingCardKeys): Promise<string> {
	return encryptJson({ format: 1, wire, hash, item } satisfies CardBody, keys.key, await context(keys, wire));
}

// A tag name is bound to its term, so the server cannot list one tag's name under another.
const tagContext = (keys: ReadingCardKeys, term: string) => ({ vaultId: keys.vaultId, scopeId: 'vault', purpose: 'reading-card' as const,
	objectId: `reading-tag-${keys.keyGeneration}-${term}` });

/** The sealed name of each of the item's tags, lowercased as the tag filter matches them. */
async function sealReadingTagNames(item: Pick<ReadingItem, 'tags'>, keys: ReadingCardKeys & { searchKey: CryptoKey }): Promise<ReadingTagName[]> {
	const names = [...new Set(item.tags.map(normalizedTag))];
	return await Promise.all(names.map(async name => {
		const term = await hashedTagTerm(keys.searchKey, name);
		return { term, name: await encryptJson({ format: 1, name }, keys.key, tagContext(keys, term)) };
	}));
}

/** A tag name the server listed under `term`, or null when it was not sealed for that term. */
export async function openReadingTagName(tag: ReadingTagName, keys: ReadingCardKeys): Promise<string | null> {
	try {
		const body = await decryptJson(tag.name, keys.key, tagContext(keys, tag.term)) as { format?: unknown; name?: unknown } | null;
		return body?.format === 1 && typeof body.name === 'string' && body.name ? body.name : null;
	} catch { return null; }
}

/** The public data a device attaches when it encrypts a Reading note for `wire`. */
export async function readingCardData(item: ReadingItem, wire: string, hash: string, keys: ReadingCardKeys & { searchKey: CryptoKey }): Promise<ReadingCardData> {
	return { kind: 'reading-card', version: 1, card: await sealReadingCard(item, wire, hash, keys), terms: await hashedReadingTerms(keys.searchKey, item), fields: readingCardFields(item),
		highlighted_at: highlightedAt(item), highlight_terms: await hashedHighlightTerms(keys.searchKey, item), tag_names: await sealReadingTagNames(item, keys) };
}

/** The item a card lists, checked against its server path. */
export async function openReadingCard(envelope: string, wire: string, keys: ReadingCardKeys): Promise<{ item: ReadingItem; hash: string }> {
	const body = await decryptJson(envelope, keys.key, await context(keys, wire)) as Partial<CardBody> | null;
	if (!body || body.format !== 1 || body.wire !== wire || typeof body.hash !== 'string' || !body.item || typeof body.item.path !== 'string') throw new Error('This Reading card is unreadable.');
	return { item: { ...validateReadingMetadata(body.item as unknown as Record<string, unknown>), path: body.item.path }, hash: body.hash };
}

/** Whether the fields the server listed a card by are the card's own. */
export function sameReadingCardFields(item: ReadingItem, fields: Partial<ReadingCardFields>): boolean {
	const own = readingCardFields(item);
	return (Object.keys(fields) as Array<keyof ReadingCardFields>).every(key => fields[key] === own[key]);
}

export const isReadingCardKind = (value: unknown) => !!value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'reading-card';

const isEnvelope = (value: unknown, max: number) => typeof value === 'string' && value.length <= max && value.split('.').length === 5 && /^[A-Za-z0-9_.-]+$/.test(value);
const uniqueTerms = (value: unknown, max: number): value is string[] => Array.isArray(value) && value.length <= max && value.every(isHashedReadingTerm) && new Set(value).size === value.length;
const isTagName = (value: unknown): value is ReadingTagName => !!value && typeof value === 'object' && Object.keys(value).length === 2
	&& isHashedReadingTerm((value as ReadingTagName).term) && isEnvelope((value as ReadingTagName).name, MAX_TAG_NAME_CHARACTERS);
const CARD_KEYS = ['kind', 'version', 'card', 'terms', 'fields', 'highlighted_at', 'highlight_terms', 'tag_names'];

/** Validates Reading public data, as the server does before listing a note from it. */
export function validateReadingCardData(value: unknown): asserts value is ReadingCardData {
	const data = value as Partial<Record<string, unknown>> | null, fields = data?.fields as Partial<ReadingCardFields> | undefined;
	let valid = !!data && typeof data === 'object' && data.version === 1 && Object.keys(data).length === CARD_KEYS.length && CARD_KEYS.every(key => key in data)
		&& data.kind === 'reading-card' && isEnvelope(data.card, MAX_CARD_CHARACTERS) && uniqueTerms(data.terms, MAX_CARD_TERMS)
		&& !!fields && typeof fields === 'object' && Object.keys(fields).length === 5 && typeof fields.item_id === 'string' && UUID.test(fields.item_id)
		&& typeof fields.saved_at === 'string' && fields.saved_at.length <= 40 && Number.isFinite(Date.parse(fields.saved_at))
		&& (fields.status === 'inbox' || fields.status === 'archived') && typeof fields.favorite === 'boolean' && typeof fields.highlighted === 'boolean';
	if (valid) {
		const { highlighted_at: at, highlight_terms: highlightTerms, tag_names: tags } = data as Record<string, unknown>;
		const terms = new Set(data!.terms as string[]);
		valid = (fields!.highlighted ? typeof at === 'string' && at.length <= 40 && Number.isFinite(Date.parse(at)) : at === null)
			&& uniqueTerms(highlightTerms, MAX_HIGHLIGHT_TERMS) && (fields!.highlighted || highlightTerms.length === 0)
			&& Array.isArray(tags) && tags.length <= MAX_CARD_TAGS && (tags as unknown[]).every(isTagName)
			&& new Set((tags as ReadingTagName[]).map(tag => tag.term)).size === tags.length && (tags as ReadingTagName[]).every(tag => terms.has(tag.term));
	}
	if (!valid) throw new Error('Invalid Reading card');
}
