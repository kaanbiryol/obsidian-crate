import { describe, expect, it } from 'vitest';
import { parseChanges, parseChangesCheck, parseFileMetadata, parseManifestPage } from './read-contracts';
import { parseFileVersions } from './version-contract';

const entry = { hash: 'a'.repeat(64), size: 5, modified: '2026-09-09 12:00:00', revision: 'opaque revision/with space' };
const page = { version: 1, files: { 'note.md': entry }, lastSeq: 1, snapshotSeq: 1, hasMore: false };
const change = { seq: 1, path: 'note.md', action: 'put', hash: entry.hash, size: 5, created_at: entry.modified, revision: entry.revision };
describe('authoritative read contracts', () => {
	it.each([undefined, null, [], 'files', 1])('rejects an invalid file map %s instead of treating it as empty', files => {
		expect(() => parseManifestPage({ ...page, files })).toThrow();
		expect(() => parseFileMetadata({ files }, ['note.md'])).toThrow();
	});
	it.each([{ hash: '' }, { size: 'damaged' }, { size: -1 }, { size: Infinity }, { modified: '2026-02-30' }, { modified: 'today' }, { revision: null }, { revision: '' }])('rejects the whole response for a damaged member %j', patch => {
		const files = { 'good.md': entry, 'bad.md': { ...entry, ...patch } };
		expect(() => parseManifestPage({ ...page, files })).toThrow();
		expect(() => parseFileMetadata({ files }, ['good.md', 'bad.md'])).toThrow();
	});
	it.each([{ version: 2 }, { lastSeq: -1 }, { snapshotSeq: 2 }, { hasMore: true }, { truncated: true }, { nextCursor: 'note.md' }])('rejects incompatible or incomplete manifest framing %j', patch => {
		expect(() => parseManifestPage({ ...page, ...patch })).toThrow();
	});
	it('accepts a valid empty manifest and refuses unsolicited targeted records', () => {
		expect(parseManifestPage({ ...page, files: {} }).files).toEqual({});
		expect(() => parseFileMetadata({ files: page.files }, ['different.md'])).toThrow();
	});
	it.each([{ seq: 0 }, { action: 'rename' }, { hash: 'broken' }, { path: '../note.md' }, { revision: {} }, { created_at: 'tomorrow' }])('rejects invalid changelog rows %j', patch => {
		expect(() => parseChanges({ changes: [{ ...change, ...patch }], lastSeq: 1, hasMore: false }, 0)).toThrow();
	});
	it('rejects non-progressing, repeated, and incomplete change pages', () => {
		for (const input of [
			{ changes: [], lastSeq: 1, hasMore: true },
			{ changes: [change, change], lastSeq: 1, hasMore: false },
			{ changes: [change], lastSeq: 2, hasMore: false },
		]) expect(() => parseChanges(input, 0)).toThrow();
		expect(() => parseChangesCheck({ lastSeq: 1, hasChanges: false }, 0)).toThrow();
	});
	it('preserves known legacy revision-less changes and cursor-expiry semantics', () => {
		expect(parseChanges({ changes: [{ ...change, revision: null }], lastSeq: 1, hasMore: false }, 0).changes).toHaveLength(1);
		expect(parseChanges({ changes: [], lastSeq: 1, hasMore: false, cursorExpired: true }, 50).cursorExpired).toBe(true);
	});
	it('requires paginated history support instead of presenting a silently truncated older response', () => {
		expect(() => parseFileVersions({ versions: [] })).toThrow('Update the Crate server');
		expect(() => parseFileVersions({ versions: [], hasMore: true, nextCursor: 'cursor' })).toThrow();
		expect(parseFileVersions({ versions: [], hasMore: false })).toEqual({ versions: [], hasMore: false });
	});
});
