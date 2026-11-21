import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReadingImageCleanup } from './image-cleanup';

const id = '0cf86c65-51e2-4e2b-8987-0a4732473588', other = '6f2f5a8e-3c55-4a0e-9d2b-8a1f0c7e4b21';
const folder = (value: string) => `Reading/attachments/${value}`;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function cleanup(state: { notes: Array<string | null | undefined>; busy?: boolean }) {
	const folders = new Set([folder(id), folder(other)]);
	const trash = vi.fn(async (path: string) => { folders.delete(path); });
	const controller = new AbortController();
	const host = new ReadingImageCleanup({ folder: 'Reading', signal: controller.signal, delayMs: 100,
		noteIds: () => state.notes, folderExists: path => folders.has(path), trash, busy: () => state.busy ?? false });
	return { host, trash, controller };
}

it('trashes a deleted note\'s images once no note has its Reading ID', async () => {
	const { host, trash } = cleanup({ notes: [other, null] });
	host.deleted(id.toUpperCase());
	host.deleted('not-an-id');
	await vi.advanceTimersByTimeAsync(100);
	expect(trash.mock.calls).toEqual([[folder(id)]]);
});

it('keeps the images of a note that came back, has a copy, or was deleted while sync writes', async () => {
	const state: { notes: Array<string | null | undefined>; busy: boolean } = { notes: [], busy: true };
	const { host, trash } = cleanup(state);
	host.deleted(id);
	await vi.advanceTimersByTimeAsync(300);
	expect(trash).not.toHaveBeenCalled();
	// Sync wrote the note again under another path, and a new note is not indexed yet.
	state.busy = false; state.notes = [undefined, id];
	await vi.advanceTimersByTimeAsync(300);
	state.notes = [other, id];
	await vi.advanceTimersByTimeAsync(100);
	expect(trash).not.toHaveBeenCalled();
});

it('does nothing after Reading stops', async () => {
	const { host, trash, controller } = cleanup({ notes: [] });
	host.deleted(id);
	controller.abort();
	await vi.advanceTimersByTimeAsync(100);
	expect(trash).not.toHaveBeenCalled();
});
