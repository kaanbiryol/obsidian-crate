import { assembleReadingArticle } from '@/reading/core/article';
import { readingUrl } from '@/reading/core/model';
import { createReadingNote, parseReadingNote } from '@/reading/core/notes';
import type { EncryptionServerState } from '@/encryption/server-state';
import type { AuthPrincipal } from '../auth/authenticate';
import { commitSealedReading } from '../coordinator/coordinator';
import { limitNotificationAction } from '../rate-limit';
import { parseJsonObject } from '../request-validation';
import type { Env } from '../types';
import { authority, ReadingError, readingResponse } from './common';
import { fetchReadingCapture } from './extraction/transport';
import { validateShortcutBody } from './shortcut-transport';

/** Save to Crate in an encrypted vault. The server downloads the page outside the
 * coordinator, then the coordinator seals the note to the vault seal key. Neither
 * the link nor the article is stored in readable form, so there is no handoff. */
export async function captureSealedReading(request: Request, env: Env, principal: AuthPrincipal, encryption: EncryptionServerState): Promise<Response> {
	if (encryption.mode !== 'active') throw new ReadingError('An encryption reset is in progress. Resume it in Obsidian.', 423);
	const limited = await limitNotificationAction(request, env.DB, principal.tokenId); if (limited) return limited;
	const current = await authority(env.DB, principal);
	const parsed = await parseJsonObject(request, 24_576);
	if (!parsed.ok) return parsed.response;
	validateShortcutBody(parsed.value, 'prepare');
	let url: string;
	try { url = readingUrl(parsed.value.url); } catch { throw new ReadingError('Share a complete HTTP or HTTPS link.'); }
	const id = crypto.randomUUID();
	const note = createReadingNote({ id, url, title: typeof parsed.value.title === 'string' ? parsed.value.title.slice(0, 1000) : undefined, savedAt: new Date().toISOString() });
	const item = parseReadingNote(note)!;
	let content: string;
	try {
		const { article, url: resolvedUrl } = await fetchReadingCapture(url, env.READING_FETCH ? request => env.READING_FETCH!.fetch(request) : fetch, env.CRATE_PUBLIC_ORIGIN);
		({ content } = assembleReadingArticle(note, item, { kind: 'capture', article, resolvedUrl }));
	} catch {
		// A page the server cannot read is still saved, with Try again in the reader.
		({ content } = assembleReadingArticle(note, item, { kind: 'capture', article: null }));
	}
	if (!await commitSealedReading(env, { id, content, folder: current.folder_path, generation: current.generation })) {
		throw new ReadingError('Crate could not save this link. Share it again.', 503, 'reading_save_failed');
	}
	return readingResponse({ saved: true, id, launchUrl: `${new URL(request.url).origin}/notifications/save-reading#saved=${id}` });
}
