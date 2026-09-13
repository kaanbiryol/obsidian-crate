import { describe, expect, it } from 'vitest';
import { prepareUploadChunks, pipelineUploadChunks } from './transfer-budget';

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

it('prepares ahead while keeping both chunks within the byte budget', async () => {
    let retained = 0;
    let peak = 0;
    const prepared: number[] = [];
    for await (const chunk of pipelineUploadChunks([0, 1, 2, 3], async index => {
        const content = new ArrayBuffer(10 * 1024 * 1024);
        prepared.push(index);
        retained += content.byteLength;
        peak = Math.max(peak, retained);
        return { path: String(index), content, size: content.byteLength, hash: 'h' };
    }, 48 * 1024 * 1024, 1)) {
        await new Promise(resolve => setTimeout(resolve, 0));
        if (chunk[0]?.path === '0') expect(prepared).toContain(1);
        retained -= chunk.reduce((sum, file) => sum + file.content.byteLength, 0);
    }
    expect(peak).toBeLessThanOrEqual(48 * 1024 * 1024);
    expect(retained).toBe(0);
});

it('settles preparation before closing an interrupted pipeline', async () => {
    let finished = false;
    const chunks = pipelineUploadChunks([0, 1, 2], async index => {
        await new Promise(resolve => setTimeout(resolve, 1));
        if (index === 1) finished = true;
        return { path: String(index), content: new ArrayBuffer(1), size: 1, hash: 'h' };
    }, 48 * 1024 * 1024, 1);
    await chunks.next();
    await chunks.return(undefined);
    expect(finished).toBe(true);
});
