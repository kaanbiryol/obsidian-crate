import { afterEach, describe, expect, it } from 'vitest';
import { Platform } from 'obsidian';
import { createLargeTransferGate, getBatchUploadConcurrency, getTransferBudgetBytes, MOBILE_LARGE_TRANSFER_BYTES as LARGE, prepareUploadChunks, pipelineUploadChunks } from './budget';

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

	it('prepares files concurrently in order while each in-flight file reserves a maximum-size slot', async () => {
		const MIB = 1024 * 1024;
		const run = async (budget: number) => {
			let active = 0, peak = 0;
			const order: string[] = [];
			for await (const chunk of prepareUploadChunks(['a', 'b', 'c', 'd'], async path => {
				peak = Math.max(peak, ++active);
				// Later files finish first; chunks still keep item order.
				await new Promise(resolve => setTimeout(resolve, path === 'a' ? 5 : 1));
				active--;
				return { path, content: new ArrayBuffer(1), size: 1, hash: 'hash', mtime: 1 };
			}, budget, 128, () => budget, 2)) order.push(...chunk.map(upload => upload.path));
			return { peak, order };
		};
		expect(await run(128 * MIB)).toEqual({ peak: 2, order: ['a', 'b', 'c', 'd'] });
		// Two 25 MiB reservations do not fit the 48 MiB phone budget.
		expect((await run(48 * MIB)).peak).toBe(1);
	});

	it('waits for preparations already started before raising a failure', async () => {
		let settled = false;
		const source = prepareUploadChunks(['fail', 'slow'], async path => {
			if (path === 'fail') throw new Error('unreadable');
			await new Promise(resolve => setTimeout(resolve, 5));
			settled = true;
			return { path, content: new ArrayBuffer(1), size: 1, hash: 'hash', mtime: 1 };
		}, 128 * 1024 * 1024, 128, undefined, 2);
		await expect(source.next()).rejects.toThrow('unreadable');
		expect(settled).toBe(true);
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

it('sizes the desktop budget and reservations for a raised file limit', async () => {
	const MIB = 1024 * 1024, limit = 100 * MIB;
	expect(getTransferBudgetBytes()).toBe(128 * MIB);
	expect(getTransferBudgetBytes(limit)).toBe(128 * MIB);
	expect(getTransferBudgetBytes(128 * MIB)).toBe(136 * MIB);
	const large = new ArrayBuffer(60 * MIB);
	const chunks: number[] = [];
	for await (const chunk of pipelineUploadChunks(['a', 'b'], async path => ({ path, content: large, size: large.byteLength, hash: 'hash', mtime: 1 }), getTransferBudgetBytes(limit), 64, limit)) {
		chunks.push(chunk.length);
	}
	// Each in-flight preparation reserves a maximum-size file, so the second waits.
	expect(chunks).toEqual([1, 1]);
	await expect(prepareUploadChunks(['a'], async () => null, 64 * MIB, 1, () => 64 * MIB, 1, limit).next()).rejects.toThrow('Invalid upload preparation budget');
});

describe('mobile transfer policy', () => {
	const mobile = Platform.isMobile;
	afterEach(() => { Platform.isMobile = mobile; });

	/** The most transfers of `sizes` that ran at once through one gate. */
	async function overlap(isMobile: boolean, sizes: number[]): Promise<number> {
		Platform.isMobile = isMobile;
		const gate = createLargeTransferGate();
		let active = 0, most = 0;
		await Promise.all(sizes.map(size => gate(size, async () => {
			most = Math.max(most, ++active);
			await new Promise(resolve => setTimeout(resolve, 5));
			active--;
		})));
		return most;
	}

	it('runs large transfers one at a time on mobile without holding back smaller ones', async () => {
		expect(await overlap(true, [LARGE, LARGE * 3, LARGE])).toBe(1);
		expect(await overlap(true, [LARGE, LARGE - 1, LARGE - 1])).toBe(3);
		expect(await overlap(false, [LARGE, LARGE])).toBe(2);
	});

	it('runs files above the default limit one at a time on desktop', async () => {
		const limit = 25 * 1024 * 1024;
		expect(await overlap(false, [limit, limit])).toBe(2);
		expect(await overlap(false, [limit + 1, limit * 2, limit])).toBe(2);
		expect(await overlap(false, [limit + 1, limit * 2])).toBe(1);
	});

	it('reads the platform when batch upload concurrency is requested', () => {
		Platform.isMobile = true;
		expect(getBatchUploadConcurrency()).toBe(2);
		Platform.isMobile = false;
		expect(getBatchUploadConcurrency()).toBe(4);
	});

	it('starts the next large transfer after one fails', async () => {
		Platform.isMobile = true;
		const gate = createLargeTransferGate();
		await expect(gate(LARGE, () => Promise.reject(new Error('lost')))).rejects.toThrow('lost');
		await expect(gate(LARGE, () => Promise.resolve('next'))).resolves.toBe('next');
	});
});
