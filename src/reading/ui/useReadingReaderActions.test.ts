import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { renderHook } from '../../test/react-hooks';
import { useReadingReaderActions } from './useReadingReaderActions';

function deferred() {
	let resolve!: () => void, reject!: (error: Error) => void;
	const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
	return { promise, resolve, reject };
}

it.each(['success', 'failure'])('ignores a replaced article’s delayed %s without releasing the current save', async outcome => {
	let article = 'provisional';
	const hook = renderHook(() => useReadingReaderActions(article));
	const old = deferred(), current = deferred(), saved = vi.fn();
	const oldActions = hook.current;
	let oldWork!: Promise<void>, currentWork!: Promise<void>;
	act(() => { oldWork = oldActions.run(async isCurrent => { await old.promise; if (isCurrent()) saved('old'); }); });
	hook.rerender();
	expect(hook.current.busy).toBe(true);
	article = 'saved'; hook.rerender();
	expect(hook.current.busy).toBe(false);
	act(() => { currentWork = hook.current.run(async isCurrent => { await current.promise; if (isCurrent()) saved('current'); }); });
	await act(async () => {
		if (outcome === 'success') old.resolve(); else old.reject(new Error('Old failure'));
		await oldWork;
	});
	expect(hook.current.busy).toBe(true);
	expect(hook.current.error).toBeNull();
	expect(saved).not.toHaveBeenCalled();
	await act(async () => { current.resolve(); await currentWork; });
	expect(hook.current.busy).toBe(false);
	expect(saved).toHaveBeenCalledExactlyOnceWith('current');
	article = 'provisional'; hook.rerender();
	await act(async () => { await oldActions.run(async () => { saved('stale callback'); }); });
	expect(saved).toHaveBeenCalledTimes(1);
});

it('fences completion callbacks and retained actions after unmount', async () => {
	const hook = renderHook(() => useReadingReaderActions('article'));
	const pending = deferred(), saved = vi.fn(), actions = hook.current;
	let work!: Promise<void>;
	act(() => { work = actions.run(async isCurrent => { await pending.promise; if (isCurrent()) saved(); }); });
	hook.unmount();
	await act(async () => { pending.resolve(); await work; await actions.run(async () => { saved(); }); });
	expect(saved).not.toHaveBeenCalled();
});

it('serializes metadata writes and shares independently', async () => {
	const hook = renderHook(() => useReadingReaderActions('article'));
	const mutation = deferred(), sharing = deferred(), duplicate = vi.fn();
	const share = vi.fn(() => sharing.promise);
	const owner = { navigator: { share } } as unknown as Window;
	let saveWork!: Promise<void>, shareWork!: Promise<void>;
	act(() => {
		saveWork = hook.current.run(() => mutation.promise);
		shareWork = hook.current.shareLink(owner, 'Article', 'https://example.com');
		void hook.current.run(duplicate);
		void hook.current.shareLink(owner, 'Article', 'https://example.com');
	});
	expect(hook.current.busy).toBe(true);
	expect(hook.current.sharing).toBe(true);
	expect(share).toHaveBeenCalledOnce();
	expect(duplicate).not.toHaveBeenCalled();
	await act(async () => { sharing.resolve(); await shareWork; });
	expect(hook.current.busy).toBe(true);
	expect(hook.current.sharing).toBe(false);
	await act(async () => { mutation.resolve(); await saveWork; });
	expect(hook.current.busy).toBe(false);
});

it.each(['replacement', 'unmount'])('does not create copy feedback after %s interrupts a clipboard write', async reason => {
	let article = 'old';
	const hook = renderHook(() => useReadingReaderActions(article));
	const copied = deferred();
	const setTimeout = vi.fn();
	const owner = { navigator: { clipboard: { writeText: () => copied.promise } }, setTimeout } as unknown as Window;
	let work!: Promise<void>;
	act(() => { work = hook.current.shareLink(owner, 'Article', 'https://example.com'); });
	if (reason === 'replacement') { article = 'new'; hook.rerender(); } else hook.unmount();
	await act(async () => { copied.resolve(); await work; });
	expect(setTimeout).not.toHaveBeenCalled();
	if (reason === 'replacement') expect(hook.current).toMatchObject({ copied: false, sharing: false, error: null });
});

it.each(['success', 'failure'])('ignores native sharing %s from the previous article while the new share is pending', async outcome => {
	let article = 'old';
	const hook = renderHook(() => useReadingReaderActions(article));
	const old = deferred(), current = deferred();
	const share = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
	const owner = { navigator: { share } } as unknown as Window;
	let oldWork!: Promise<void>, currentWork!: Promise<void>;
	act(() => { oldWork = hook.current.shareLink(owner, 'Old', 'https://example.com/old'); });
	article = 'new'; hook.rerender();
	expect(hook.current.sharing).toBe(false);
	act(() => { currentWork = hook.current.shareLink(owner, 'New', 'https://example.com/new'); });
	await act(async () => {
		if (outcome === 'success') old.resolve(); else old.reject(new Error('Could not share the previous article'));
		await oldWork;
	});
	expect(hook.current).toMatchObject({ sharing: true, error: null });
	await act(async () => { current.resolve(); await currentWork; });
	expect(hook.current.sharing).toBe(false);
});

it('cancels copy timers on replacement and unmount and fences an already queued timer', async () => {
	let article = 'old';
	const hook = renderHook(() => useReadingReaderActions(article));
	const timers: Array<() => void> = [];
	const clearTimeout = vi.fn();
	const owner = { navigator: { clipboard: { writeText: async () => {} } },
		setTimeout: (action: () => void) => timers.push(action), clearTimeout } as unknown as Window;
	await act(async () => { await hook.current.shareLink(owner, 'Old', 'https://example.com/old'); });
	expect(hook.current.copied).toBe(true);
	article = 'new'; hook.rerender();
	expect(clearTimeout).toHaveBeenCalledWith(1);
	expect(hook.current.copied).toBe(false);
	await act(async () => { await hook.current.shareLink(owner, 'New', 'https://example.com/new'); });
	act(() => { timers[0]!(); });
	expect(hook.current.copied).toBe(true);
	hook.unmount();
	expect(clearTimeout).toHaveBeenCalledWith(2);
});
