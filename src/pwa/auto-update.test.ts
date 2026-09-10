import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startAutoPwaUpdate } from './auto-update';
import { preparePwaUpdate } from './apply-update';

vi.mock('./apply-update', () => ({ preparePwaUpdate: vi.fn() }));

describe('foreground automatic PWA updates', () => {
	let doc: EventTarget & { visibilityState: string; querySelector: ReturnType<typeof vi.fn> };
	let win: EventTarget;
	let online: { onLine: boolean };
	let memory: Map<string, string>;
	let stop: () => void;
	const safe = vi.fn(() => true);
	const apply = vi.fn(async (_version: string, guard: () => boolean, mark: () => boolean) => guard() && mark());

	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		safe.mockReturnValue(true);
		vi.mocked(preparePwaUpdate).mockResolvedValue(null);
		doc = Object.assign(new EventTarget(), { visibilityState: 'visible', querySelector: vi.fn(() => null) });
		win = new EventTarget();
		online = { onLine: true };
		memory = new Map();
		vi.stubGlobal('document', doc);
		vi.stubGlobal('window', win);
		vi.stubGlobal('navigator', online);
		vi.stubGlobal('sessionStorage', {
			getItem: (key: string) => memory.get(key) ?? null,
			setItem: (key: string, value: string) => memory.set(key, value),
		});
	});
	afterEach(() => { stop?.(); vi.useRealTimers(); vi.unstubAllGlobals(); });

	it('precaches immediately and applies once after an idle interval', async () => {
		stop = startAutoPwaUpdate('new', safe, apply);
		expect(preparePwaUpdate).toHaveBeenCalledWith('new');
		expect(apply).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(apply).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(apply).toHaveBeenCalledOnce();
		stop();
		stop = startAutoPwaUpdate('new', safe, apply);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(apply).toHaveBeenCalledOnce(); // Old shell cannot enter a reload loop.
	});

	it('waits for editors and pending work, then applies without a tap', async () => {
		safe.mockReturnValue(false);
		stop = startAutoPwaUpdate('new', safe, apply);
		await vi.advanceTimersByTimeAsync(8_000);
		expect(preparePwaUpdate).toHaveBeenCalledOnce();
		expect(apply).not.toHaveBeenCalled();
		safe.mockReturnValue(true);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(apply).toHaveBeenCalledOnce();
	});

	it('waits for touch release, scrolling, and nested dialogs', async () => {
		stop = startAutoPwaUpdate('new', safe, apply);
		doc.dispatchEvent(new Event('pointerdown'));
		await vi.advanceTimersByTimeAsync(5_000);
		expect(apply).not.toHaveBeenCalled();
		doc.dispatchEvent(new Event('pointerup'));
		await vi.advanceTimersByTimeAsync(1_500);
		doc.dispatchEvent(new Event('scroll'));
		await vi.advanceTimersByTimeAsync(1_500);
		expect(apply).not.toHaveBeenCalled();
		doc.querySelector.mockReturnValue({} as never);
		await vi.advanceTimersByTimeAsync(3_000);
		expect(apply).not.toHaveBeenCalled();
		doc.querySelector.mockReturnValue(null);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(apply).toHaveBeenCalledOnce();
	});

	it.each(['visibilitychange', 'pageshow'])('resumes after iPhone suspension via %s', async event => {
		doc.visibilityState = 'hidden';
		stop = startAutoPwaUpdate('new', safe, apply);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(preparePwaUpdate).not.toHaveBeenCalled();
		doc.visibilityState = 'visible';
		(event === 'pageshow' ? win : doc).dispatchEvent(new Event(event));
		await vi.advanceTimersByTimeAsync(2_000);
		expect(apply).toHaveBeenCalledOnce();
	});

	it('retries a failed download on reconnect without an automatic retry loop', async () => {
		vi.mocked(preparePwaUpdate).mockRejectedValueOnce(new Error('Offline'));
		stop = startAutoPwaUpdate('new', safe, apply);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(preparePwaUpdate).toHaveBeenCalledOnce();
		expect(apply).not.toHaveBeenCalled();
		win.dispatchEvent(new Event('online'));
		await vi.advanceTimersByTimeAsync(2_000);
		expect(apply).toHaveBeenCalledOnce();
	});

	it('does not activate after backgrounding during a download or after cleanup', async () => {
		let resolve!: (worker: null) => void;
		vi.mocked(preparePwaUpdate).mockReturnValue(new Promise(done => { resolve = done; }));
		stop = startAutoPwaUpdate('new', safe, apply);
		await vi.advanceTimersByTimeAsync(2_000);
		doc.visibilityState = 'hidden';
		doc.dispatchEvent(new Event('visibilitychange'));
		resolve(null);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(apply).not.toHaveBeenCalled();
		stop();
		doc.visibilityState = 'visible';
		win.dispatchEvent(new Event('pageshow'));
		await vi.advanceTimersByTimeAsync(5_000);
		expect(apply).not.toHaveBeenCalled();
	});
});
