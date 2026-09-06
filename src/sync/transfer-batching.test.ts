import { describe, expect, it } from 'vitest';
import type { PreparedUpload } from './types';
import { createBatchUploadChunks } from './transfer';

describe('batch upload chunking', () => {
	it('respects file count limit', () => {
		const prepared: PreparedUpload[] = Array.from({ length: 14 }, (_, i) => ({
			path: `file-${i}.md`,
			content: new ArrayBuffer(100),
			hash: `hash-${i}`,
			size: 100,
			contentType: 'text/plain',
		}));

		const chunks = createBatchUploadChunks(prepared);

		expect(chunks).toHaveLength(3);
		expect(chunks[0]).toHaveLength(5);
		expect(chunks[1]).toHaveLength(5);
		expect(chunks[2]).toHaveLength(4);
	});

	it('respects byte size limit', () => {
		const prepared: PreparedUpload[] = [
			{ path: 'a.md', content: new ArrayBuffer(6_000_000), hash: 'a', size: 6_000_000, contentType: 'text/plain' },
			{ path: 'b.md', content: new ArrayBuffer(6_000_000), hash: 'b', size: 6_000_000, contentType: 'text/plain' },
			{ path: 'c.md', content: new ArrayBuffer(100), hash: 'c', size: 100, contentType: 'text/plain' },
		];

		const chunks = createBatchUploadChunks(prepared);

		// a.md = 6MB (first chunk), b.md = 6MB won't fit with a.md (new chunk), c.md fits with b.md
		expect(chunks).toHaveLength(2);
		expect(chunks[0]).toHaveLength(1);
		expect(chunks[0]?.[0]?.path).toBe('a.md');
		expect(chunks[1]).toHaveLength(2);
		expect(chunks[1]?.[0]?.path).toBe('b.md');
		expect(chunks[1]?.[1]?.path).toBe('c.md');
	});

	it('returns empty array for empty input', () => {
		expect(createBatchUploadChunks([])).toEqual([]);
	});
});
