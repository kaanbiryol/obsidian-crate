import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createImageUrls } from './image-urls';

let next = 0;
const revoked: string[] = [];
beforeEach(() => {
	next = 0; revoked.length = 0;
	vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${++next}`);
	vi.spyOn(URL, 'revokeObjectURL').mockImplementation(url => { revoked.push(url); });
});
afterEach(() => { vi.restoreAllMocks(); });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

it('shares one download per image and revokes unused URLs past the idle limit', async () => {
	const fetchImage = vi.fn(async () => new Blob(['x']));
	const urls = createImageUrls(fetchImage, 1);
	const first = new AbortController(), second = new AbortController();
	expect(await urls.load('a.png', first.signal)).toBe('blob:1');
	expect(await urls.load('a.png', second.signal)).toBe('blob:1');
	expect(fetchImage).toHaveBeenCalledTimes(1);
	first.abort(); await settle();
	// Another view still shows it.
	expect(revoked).toEqual([]);
	second.abort(); await settle();
	expect(revoked).toEqual([]);
	// A second unused image pushes the oldest past the limit.
	const other = new AbortController();
	await urls.load('b.png', other.signal);
	other.abort(); await settle();
	expect(revoked).toEqual(['blob:1']);
	// An image kept for reuse needs no download; a revoked one downloads again.
	await urls.load('b.png', new AbortController().signal);
	await urls.load('a.png', new AbortController().signal);
	expect(fetchImage).toHaveBeenCalledTimes(3);
});

it('cancels a download every view stopped waiting for, but not one reloaded in the same commit', async () => {
	let finish!: () => void;
	const signals: AbortSignal[] = [];
	const urls = createImageUrls(async (_path, signal) => { signals.push(signal); await new Promise<void>(resolve => { finish = resolve; }); return new Blob(['x']); });
	const view = new AbortController();
	void urls.load('a.png', view.signal);
	// An effect cleans up and runs again for the same image.
	view.abort();
	const again = new AbortController();
	const url = urls.load('a.png', again.signal);
	await settle();
	expect(signals[0]!.aborted).toBe(false);
	again.abort(); await settle();
	expect(signals[0]!.aborted).toBe(true);
	finish();
	expect(await url).toBeNull();
});

it('revokes every URL when cleared', async () => {
	const urls = createImageUrls(async () => new Blob(['x']));
	await urls.load('a.png', new AbortController().signal);
	urls.clear(); await settle();
	expect(revoked).toEqual(['blob:1']);
});
