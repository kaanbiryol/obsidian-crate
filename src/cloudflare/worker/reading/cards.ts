import type { Env } from '../types';
import type { ReadingPolicy } from '@/protocol/reading-policy';
import { readingResponse, ReadingError } from './common';
import { isHashedReadingTerm } from '@/encryption/reading-search';
import { isReceiptEnvelope } from '@/encryption/receipt-format';
import { readingTimestamp } from '@/reading/core/model';
import { portablePathKey } from '@/protocol/portable-path';
import { isSyncRevision } from '@/protocol/sync-validation';
import { isReadingNotePath } from './library-index';
import { changedRows } from '../d1/db';

/** Notes one stale listing or one card post covers. */
const READING_CARD_BATCH = 50;
const MAX_CARD_TERMS = 400;
const MAX_CARD_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Encrypted notes whose row has no card for their current revision, after the `after`
 * server path, with the card of an earlier revision when there is one. */
export async function staleReadingCards(env: Env, params: URLSearchParams) {
	const after = params.get('after') ?? '';
	if (after.length > 1024) throw new ReadingError('Invalid cursor.');
	const { results } = await env.DB.prepare(`SELECT path, portable_path, storage_key AS revision, hash, size, card FROM reading_items
    WHERE stale = 1 AND portable_path > ? ORDER BY portable_path LIMIT ${READING_CARD_BATCH}`).bind(portablePathKey(after))
		.all<{ path: string; portable_path: string; revision: string; hash: string; size: number; card: string | null }>();
	return readingResponse({ files: results.map(({ portable_path: _portable, card, ...file }) => ({ ...file, ...card ? { card } : {} })),
		cursor: results.length === READING_CARD_BATCH ? results.at(-1)!.path : null });
}

/** Which of these server paths hold a note in the Reading folder, so a device can tell
 * whether a name is taken without the server reading names. */
export async function existingReadingPaths(env: Env, current: ReadingPolicy, params: URLSearchParams) {
	const paths = params.getAll('path');
	if (!paths.length || paths.length > 20 || !paths.every(path => isReadingNotePath(path, current.folder_path))) throw new ReadingError('Invalid Reading paths.');
	const { results } = await env.DB.prepare(`SELECT path FROM reading_items WHERE portable_path IN (SELECT value FROM json_each(?))`)
		.bind(JSON.stringify(paths.map(portablePathKey))).all<{ path: string }>();
	return readingResponse({ paths: results.map(row => row.path) });
}

interface PostedCard { path: string; revision: string; card: string; terms: string[]; item_id: string; saved_at: string; status: 'inbox' | 'archived'; favorite: boolean; highlighted: boolean }

function postedCard(value: unknown, folder: string): PostedCard {
	const card = value as Partial<PostedCard> | null;
	if (!card || typeof card !== 'object' || Object.keys(card).some(key => !['path', 'revision', 'card', 'terms', 'item_id', 'saved_at', 'status', 'favorite', 'highlighted'].includes(key))
		|| typeof card.path !== 'string' || !isReadingNotePath(card.path, folder) || !isSyncRevision(card.revision)
		|| !isReceiptEnvelope(card.card) || card.card.length > MAX_CARD_BYTES
		|| !Array.isArray(card.terms) || card.terms.length > MAX_CARD_TERMS || !card.terms.every(isHashedReadingTerm)
		|| typeof card.item_id !== 'string' || !UUID.test(card.item_id) || (card.status !== 'inbox' && card.status !== 'archived')
		|| typeof card.favorite !== 'boolean' || typeof card.highlighted !== 'boolean') throw new ReadingError('Invalid Reading card.');
	try { readingTimestamp(card.saved_at); } catch { throw new ReadingError('Invalid Reading card.'); }
	return card as PostedCard;
}

/** Stores the cards devices posted. Each applies only while its row still names that path
 * and revision, so a card never lists another version of the note; others are skipped. */
export async function postReadingCards(env: Env, current: ReadingPolicy, body: Record<string, unknown>): Promise<Response> {
	if (!Array.isArray(body.cards) || !body.cards.length || body.cards.length > READING_CARD_BATCH || Object.keys(body).some(key => key !== 'cards')) throw new ReadingError('Invalid Reading cards.');
	const cards = body.cards.map(card => postedCard(card, current.folder_path));
	if (new Set(cards.map(card => portablePathKey(card.path))).size !== cards.length) throw new ReadingError('Invalid Reading cards.');
	const db = env.DB, statements: D1PreparedStatement[] = [];
	for (const card of cards) {
		const portable = portablePathKey(card.path), terms = JSON.stringify([...new Set(card.terms)]);
		const match = 'EXISTS (SELECT 1 FROM reading_items WHERE portable_path = ?1 AND path = ?2 AND storage_key = ?3)';
		const args = [portable, card.path, card.revision];
		statements.push(
			db.prepare(`DELETE FROM reading_terms WHERE portable_path = ?1 AND ${match}
        AND (SELECT terms FROM reading_items WHERE portable_path = ?1) IS NOT ?4`).bind(...args, terms),
			db.prepare(`INSERT OR IGNORE INTO reading_terms(term, portable_path) SELECT value, ?1 FROM json_each(?4) WHERE ${match}`).bind(...args, terms),
			db.prepare(`UPDATE reading_items SET card = ?4, terms = ?5, item_id = ?6, saved_at = ?7, status = ?8, favorite = ?9, highlighted = ?10, stale = 0,
        change_seq = COALESCE((SELECT seq FROM reading_index WHERE id = 1), 0) WHERE portable_path = ?1 AND path = ?2 AND storage_key = ?3`)
				.bind(...args, card.card, terms, card.item_id, card.saved_at, card.status, card.favorite ? 1 : 0, card.highlighted ? 1 : 0),
		);
	}
	const results = await db.batch(statements);
	const accepted = cards.filter((_card, index) => changedRows(results[index * 3 + 2]) > 0).map(card => card.path);
	return readingResponse({ accepted });
}
