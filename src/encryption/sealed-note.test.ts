import { describe, expect, it } from 'vitest';
import { sealedNoteRefusal } from './sealed-note';

describe('sealedNoteRefusal', () => {
	const note = { wire: 'R/new.md', path: 'Reading/Article.md', hash: 'a' };
	it('accepts a note at a new server path under a free name', () => {
		expect(sealedNoteRefusal(note, [])).toBeNull();
		expect(sealedNoteRefusal(note, [{ wire: 'R/other.md', path: 'Reading/Other.md', hash: 'b' }])).toBeNull();
	});
	it('accepts a known server path only with the plaintext and name held there', () => {
		expect(sealedNoteRefusal(note, [{ ...note }])).toBeNull();
		expect(sealedNoteRefusal(note, [{ ...note, hash: 'b' }])).toEqual({ kind: 'replaces', held: { ...note, hash: 'b' } });
		expect(sealedNoteRefusal(note, [{ ...note, path: 'Reading/Renamed.md' }])).toEqual({ kind: 'replaces', held: { ...note, path: 'Reading/Renamed.md' } });
	});
	it('rejects the name of a note at another server path, in any letter case', () => {
		expect(sealedNoteRefusal(note, [{ wire: 'R/old.md', path: 'Reading/Article.md', hash: 'a' }])).toEqual({ kind: 'name-taken' });
		expect(sealedNoteRefusal(note, [{ wire: 'R/old.md', path: 'reading/ARTICLE.md', hash: 'b' }])).toEqual({ kind: 'name-taken' });
	});
});
