import { portablePathKey } from '@/protocol/portable-path';

/** A Reading note by its server path (`wire`), plaintext path and authenticated
 * plaintext hash (empty when unknown). */
export interface KnownReadingNote { wire: string; path: string; hash: string }

/** The server may only create sealed notes. One is accepted at a server path this web
 * app already knows only with the plaintext it holds, and never under the name of a
 * note stored at another server path. A known untouched Shortcut note counts too. */
export function acceptsSealedNote(note: KnownReadingNote, known: KnownReadingNote[]): boolean {
	const held = known.find(other => other.wire === note.wire);
	if (held) return held.path === note.path && held.hash === note.hash;
	const key = portablePathKey(note.path);
	return !known.some(other => portablePathKey(other.path) === key);
}
