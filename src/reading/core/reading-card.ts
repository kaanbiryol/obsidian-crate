import { decryptJson, encryptJson, type EncryptionKey } from '@/encryption/envelope';
import { hashedReadingTerms, isHashedReadingTerm } from '@/encryption/reading-search';
import { deriveP256Secret, generateEphemeralP256, validateP256PublicKey } from '@/encryption/p256';
import { isEncryptionId } from '@/encryption/encoding';
import { openSealedFileKey, sealedFileKey, type SealOpenKey } from '@/encryption/sealed-file-key';
import { sha256Hex } from '@/platform/sha256';
import { validateReadingMetadata, type ReadingItem } from './model';

/**
 * An encrypted vault's listed item for one note revision. The device that encrypts a Reading
 * note attaches it to the note's upload as the file's public data (`readingCardData`), like a
 * reminder note's schedules, and the server lists the note from it in the same commit. The
 * server stores the envelope, the plaintext list fields and the hashed terms; it cannot read
 * the card. A note the server sealed (a Shortcut save) carries a card sealed to the vault seal
 * key, with no terms, since only devices can hash them.
 */
export interface ReadingCardKeys { vaultId: string; key: EncryptionKey; keyGeneration: number }
/** `wire` is the note's server path and `hash` its authenticated plaintext hash; the item
 * carries its plaintext path. */
interface CardBody { format: 1; wire: string; hash: string; item: ReadingItem }
/** What the server sorts and filters by. A device that reads a card checks them. */
export interface ReadingCardFields { item_id: string; saved_at: string; status: ReadingItem['reading_status']; favorite: boolean; highlighted: boolean }
/** A Reading note's public data. `seal` marks a card the server sealed to the vault seal key. */
export interface ReadingCardData { kind: 'reading-card'; version: 1; card: string; terms: string[]; fields: ReadingCardFields; seal?: { keyId: string; epk: string } }

const MAX_CARD_TERMS = 400;
const MAX_CARD_CHARACTERS = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// The object ID binds the envelope to its server path, so the server cannot list one note's card as another.
const cardObject = async (wire: string, prefix: string) => `${prefix}-${(await sha256Hex(wire)).slice(0, 32)}`;
const context = async (keys: ReadingCardKeys, wire: string) => ({ vaultId: keys.vaultId, scopeId: 'vault', purpose: 'reading-card' as const,
	objectId: await cardObject(wire, `reading-card-${keys.keyGeneration}`) });
const sealedContext = async (vaultId: string, wire: string) => ({ vaultId, scopeId: 'vault', purpose: 'reading-card' as const, objectId: await cardObject(wire, 'reading-card-sealed') });

const readingCardFields = (item: ReadingItem): ReadingCardFields => ({ item_id: item.crate_reading_id, saved_at: item.saved_at,
	status: item.reading_status, favorite: item.favorite, highlighted: !!item.highlights?.length });

export async function sealReadingCard(item: ReadingItem, wire: string, hash: string, keys: ReadingCardKeys): Promise<string> {
	return encryptJson({ format: 1, wire, hash, item } satisfies CardBody, keys.key, await context(keys, wire));
}

/** The public data a device attaches when it encrypts a Reading note for `wire`. */
export async function readingCardData(item: ReadingItem, wire: string, hash: string, keys: ReadingCardKeys & { searchKey: CryptoKey }): Promise<ReadingCardData> {
	return { kind: 'reading-card', version: 1, card: await sealReadingCard(item, wire, hash, keys), terms: await hashedReadingTerms(keys.searchKey, item), fields: readingCardFields(item) };
}

/** The public data the server attaches to a note it sealed: readable by unlocked devices, not by the server. */
export async function sealedReadingCardData(item: ReadingItem, wire: string, hash: string, recipient: { vaultId: string; keyId: string; publicKey: string }): Promise<ReadingCardData> {
	const context = await sealedContext(recipient.vaultId, wire), ephemeral = await generateEphemeralP256();
	const key = await sealedFileKey(await deriveP256Secret(ephemeral.privateKey, recipient.publicKey),
		{ vaultId: recipient.vaultId, objectId: context.objectId, keyId: recipient.keyId, epk: ephemeral.publicKey, recipient: recipient.publicKey });
	return { kind: 'reading-card', version: 1, card: await encryptJson({ format: 1, wire, hash, item } satisfies CardBody, key, context), terms: [],
		fields: readingCardFields(item), seal: { keyId: recipient.keyId, epk: ephemeral.publicKey } };
}

/** The item a card lists, checked against its server path. A sealed card needs the seal key. */
export async function openReadingCard(envelope: string, wire: string, keys: ReadingCardKeys & { seal?: SealOpenKey }, seal?: ReadingCardData['seal']): Promise<{ item: ReadingItem; hash: string }> {
	let body: Partial<CardBody> | null;
	if (seal) {
		if (!keys.seal || keys.seal.keyId !== seal.keyId) throw new Error('This Reading card is unreadable.');
		const context = await sealedContext(keys.vaultId, wire);
		body = await decryptJson(envelope, await openSealedFileKey({ vaultId: keys.vaultId, objectId: context.objectId, keyId: seal.keyId, seal: { epk: seal.epk } }, keys.seal), context) as Partial<CardBody> | null;
	} else body = await decryptJson(envelope, keys.key, await context(keys, wire)) as Partial<CardBody> | null;
	if (!body || body.format !== 1 || body.wire !== wire || typeof body.hash !== 'string' || !body.item || typeof body.item.path !== 'string') throw new Error('This Reading card is unreadable.');
	return { item: { ...validateReadingMetadata(body.item as unknown as Record<string, unknown>), path: body.item.path }, hash: body.hash };
}

/** Whether the fields the server listed a card by are the card's own. */
export function sameReadingCardFields(item: ReadingItem, fields: Partial<ReadingCardFields>): boolean {
	const own = readingCardFields(item);
	return (Object.keys(fields) as Array<keyof ReadingCardFields>).every(key => fields[key] === own[key]);
}

export const isReadingCardKind = (value: unknown) => !!value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'reading-card';

/** Validates Reading public data, as the server does before listing a note from it. */
export function validateReadingCardData(value: unknown): asserts value is ReadingCardData {
	const data = value as Partial<ReadingCardData> | null, fields = data?.fields as Partial<ReadingCardFields> | undefined;
	const valid = !!data && typeof data === 'object' && Object.keys(data).every(key => ['kind', 'version', 'card', 'terms', 'fields', 'seal'].includes(key))
		&& data.kind === 'reading-card' && data.version === 1 && typeof data.card === 'string' && data.card.length <= MAX_CARD_CHARACTERS
		&& data.card.split('.').length === 5 && /^[A-Za-z0-9_.-]+$/.test(data.card)
		&& Array.isArray(data.terms) && data.terms.length <= MAX_CARD_TERMS && data.terms.every(isHashedReadingTerm) && new Set(data.terms).size === data.terms.length
		&& !!fields && typeof fields === 'object' && Object.keys(fields).length === 5 && typeof fields.item_id === 'string' && UUID.test(fields.item_id)
		&& typeof fields.saved_at === 'string' && fields.saved_at.length <= 40 && Number.isFinite(Date.parse(fields.saved_at))
		&& (fields.status === 'inbox' || fields.status === 'archived') && typeof fields.favorite === 'boolean' && typeof fields.highlighted === 'boolean'
		&& (data.seal === undefined || !!data.seal && typeof data.seal === 'object' && Object.keys(data.seal).length === 2 && isEncryptionId(data.seal.keyId)
			&& typeof data.seal.epk === 'string' && data.terms.length === 0);
	if (!valid) throw new Error('Invalid Reading card');
	if (data.seal) validateP256PublicKey(data.seal.epk);
}
