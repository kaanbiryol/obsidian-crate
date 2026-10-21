import { describe, expect, it } from 'vitest';
import { BATCH_ASSET_UPLOAD_MAX_FILES, BATCH_UPLOAD_MAX_FILES, BULK_NEW_UPLOAD_MAX_FILES, maxUploadBatchFiles } from './sync-limits';

describe('upload batch file limit', () => {
	const added = (path: string) => ({ path, expectedHash: null });
	const edited = (path: string) => ({ path, expectedHash: 'a'.repeat(64) });

	it('allows a new-file import only when every file is new and the batch is eligible', () => {
		expect(maxUploadBatchFiles([added('a.md'), added('b.png')], true)).toBe(BULK_NEW_UPLOAD_MAX_FILES);
		expect(maxUploadBatchFiles([added('a.md'), added('b.png')], false)).toBe(BATCH_UPLOAD_MAX_FILES);
		expect(maxUploadBatchFiles([added('a.png'), edited('b.png')], true)).toBe(BATCH_ASSET_UPLOAD_MAX_FILES);
		// An unknown precondition is not an absent one.
		expect(maxUploadBatchFiles([{ path: 'a.png' }], true)).toBe(BATCH_ASSET_UPLOAD_MAX_FILES);
	});

	it('limits any batch with Markdown to the reminder-indexed size', () => {
		expect(maxUploadBatchFiles([edited('a.png'), edited('Notes/B.MD')], true)).toBe(BATCH_UPLOAD_MAX_FILES);
		expect(maxUploadBatchFiles([edited('a.png'), edited('b.pdf')], true)).toBe(BATCH_ASSET_UPLOAD_MAX_FILES);
	});
});
