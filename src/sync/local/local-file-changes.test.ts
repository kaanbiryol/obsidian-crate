import { describe, expect, it } from 'vitest';
import { MAX_FILE_SIZE_BYTES } from '../../protocol/sync-limits';
import { hasLocalMetadataChange, isOversizedSyncFile } from './local-file-changes';

describe('local change predicates', () => {
	const entry = { size: 12, modified: new Date(1_700_000_000_000).toISOString() };

	it('treats untracked, resized, retimed and unverified files as changed', () => {
		expect(hasLocalMetadataChange({ size: 12, mtime: 1_700_000_000_000 }, entry)).toBe(false);
		expect(hasLocalMetadataChange({ size: 12, mtime: 1_700_000_000_000 }, undefined)).toBe(true);
		expect(hasLocalMetadataChange({ size: 13, mtime: 1_700_000_000_000 }, entry)).toBe(true);
		expect(hasLocalMetadataChange({ size: 12, mtime: 1_700_000_000_001 }, entry)).toBe(true);
		expect(hasLocalMetadataChange({ size: 12, mtime: 1_700_000_000_000 }, { size: 12, modified: 'unverified' })).toBe(true);
	});

	it('flags files above the sync size limit', () => {
		expect(isOversizedSyncFile({ size: MAX_FILE_SIZE_BYTES })).toBe(false);
		expect(isOversizedSyncFile({ size: MAX_FILE_SIZE_BYTES + 1 })).toBe(true);
	});
});
