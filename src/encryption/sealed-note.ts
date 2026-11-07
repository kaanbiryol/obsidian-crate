import { portablePathKey } from '../protocol/portable-path';

/** A note by its server path (`wire`), plaintext path and authenticated plaintext hash. */
export interface KnownNote { wire: string; path: string; hash: string }

export type SealedNoteRefusal =
	/** The server path holds `held`, with another name or plaintext. */
	| { kind: 'replaces'; held: KnownNote }
	/** Another server path holds a note with this name, in any letter case. */
	| { kind: 'name-taken' };

/** The server may only create sealed notes. One is accepted at a server path this
 * device already knows only with the plaintext it holds there, and never under the
 * name of a note stored at another server path. A known untouched Shortcut note
 * counts too. Returns why the note is refused, or null when it is accepted. The
 * plugin and the web app both apply this rule. */
export function sealedNoteRefusal(note: KnownNote, known: readonly KnownNote[]): SealedNoteRefusal | null {
	const held = known.find(other => other.wire === note.wire);
	if (held) return held.path === note.path && held.hash === note.hash ? null : { kind: 'replaces', held };
	const key = portablePathKey(note.path);
	return known.some(other => portablePathKey(other.path) === key) ? { kind: 'name-taken' } : null;
}
