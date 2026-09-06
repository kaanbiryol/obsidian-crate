import { describe, expect, it } from 'vitest';
import { prepareUploadChunks } from './transfer-budget';

describe('bounded upload preparation', () => {
	it('uploads each chunk before preparing the remaining files', async () => {
		const content = new ArrayBuffer(10 * 1024 * 1024);
		const paths = Array.from({ length: 10 }, (_, index) => `image-${index}.png`);
		const events: string[] = [];
		let retainedBytes = 0;
		let peakBytes = 0;
		for await (const chunk of prepareUploadChunks(paths, async path => {
			events.push(`prepare:${path}`);
			retainedBytes += content.byteLength;
			peakBytes = Math.max(peakBytes, retainedBytes);
			return { path, content, size: content.byteLength, hash: 'hash', mtime: 1 };
		}, 48 * 1024 * 1024)) {
			events.push('upload');
			expect(chunk.reduce((sum, upload) => sum + upload.content.byteLength, 0)).toBe(retainedBytes);
			retainedBytes = 0;
		}
		expect(peakBytes).toBeLessThanOrEqual(48 * 1024 * 1024);
		expect(events.indexOf('upload')).toBeLessThan(events.indexOf('prepare:image-9.png'));
		expect(retainedBytes).toBe(0);
	});

	it('bounds tiny files by count and skips unchanged files', async () => {
		const sizes: number[] = [];
		for await (const chunk of prepareUploadChunks([0, 1, 2, 3, 4], async index => index === 2 ? null : {
			path: String(index), content: new ArrayBuffer(0), size: 0, hash: 'hash', mtime: 1,
		}, 48 * 1024 * 1024, 2)) sizes.push(chunk.length);
		expect(sizes).toEqual([2, 2]);
	});
});
