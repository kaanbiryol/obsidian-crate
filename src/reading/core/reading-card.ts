import { decryptJson, encryptJson, type EncryptionKey } from '@/encryption/envelope';
import { sha256Hex } from '@/platform/sha256';
import { validateReadingMetadata, type ReadingItem } from './model';

/**
 * An encrypted vault's listed item for one note revision, which a device posts for the
 * server to list (`POST /reading/cards`). The server stores the envelope and the plaintext
 * list fields; it cannot read the card.
 */
export interface ReadingCardKeys { vaultId: string; key: EncryptionKey; keyGeneration: number }
/** `wire` is the note's server path and `hash` its authenticated plaintext hash; the item
 * carries its plaintext path. */
interface CardBody { format: 1; wire: string; hash: string; item: ReadingItem }
/** What the server sorts and filters by. A device that reads a card checks them. */
export interface ReadingCardFields { item_id: string; saved_at: string; status: ReadingItem['reading_status']; favorite: boolean; highlighted: boolean }

// The object ID binds the envelope to its server path, so the server cannot list one note's card as another.
const context = async (keys: ReadingCardKeys, wire: string) => ({ vaultId: keys.vaultId, scopeId: 'vault', purpose: 'reading-card' as const,
	objectId: `reading-card-${keys.keyGeneration}-${(await sha256Hex(wire)).slice(0, 32)}` });

export const readingCardFields = (item: ReadingItem): ReadingCardFields => ({ item_id: item.crate_reading_id, saved_at: item.saved_at,
	status: item.reading_status, favorite: item.favorite, highlighted: !!item.highlights?.length });

export async function sealReadingCard(item: ReadingItem, wire: string, hash: string, keys: ReadingCardKeys): Promise<string> {
	return encryptJson({ format: 1, wire, hash, item } satisfies CardBody, keys.key, await context(keys, wire));
}

/** The item a card lists, checked against its server path and the fields the server listed it by. */
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
