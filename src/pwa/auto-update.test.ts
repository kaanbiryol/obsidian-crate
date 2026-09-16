import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startAutoPwaUpdate } from './auto-update';
import { preparePwaUpdate } from './apply-update';

vi.mock('./apply-update', () => ({ preparePwaUpdate: vi.fn() }));

describe('launch-only automatic PWA updates', () => {
	let doc: { visibilityState: string; querySelector: ReturnType<typeof vi.fn> };
	let memory: Map<string, string>;
	let stop: () => void;
	const safe = vi.fn(() => true);
	const deferred = vi.fn();
	const apply = vi.fn(async (_version: string, guard: () => boolean, mark: () => boolean) => guard() && mark());

	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		safe.mockReturnValue(true);
		vi.mocked(preparePwaUpdate).mockResolvedValue(null);
		doc = { visibilityState: 'visible', querySelector: vi.fn(() => null) };
		memory = new Map();
		vi.stubGlobal('document', doc);
		vi.stubGlobal('navigator', { onLine: true });
		vi.stubGlobal('sessionStorage', {
			getItem: (key: string) => memory.get(key) ?? null,
			setItem: (key: string, value: string) => memory.set(key, value),
		});
	});
	afterEach(() => { stop?.(); vi.useRealTimers(); vi.unstubAllGlobals(); });

	it('precaches and applies immediately while launch is safe, without an idle delay', async () => {
		stop = startAutoPwaUpdate('new', safe, apply, deferred);
		await vi.advanceTimersByTimeAsync(0);
		expect(preparePwaUpdate).toHaveBeenCalledWith('new');
		expect(apply).toHaveBeenCalledOnce();
		stop();
		stop = startAutoPwaUpdate('new', safe, apply, deferred);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(apply).toHaveBeenCalledOnce();
		expect(deferred).toHaveBeenCalledOnce();
	});

	it('waits for hydration and pending work while the launch window remains open', async () => {
		safe.mockReturnValue(false);
		stop = startAutoPwaUpdate('new', safe, apply, deferred);
		await vi.advanceTimersByTimeAsync(500);
		expect(apply).not.toHaveBeenCalled();
		safe.mockReturnValue(true);
		await vi.advanceTimersByTimeAsync(50);
		expect(apply).toHaveBeenCalledOnce();
	});

	it('does not activate after the launch window closes during a download', async () => {
		let resolve!: (worker: null) => void;
		vi.mocked(preparePwaUpdate).mockReturnValue(new Promise(done => { resolve = done; }));
		stop = startAutoPwaUpdate('new', safe, apply, deferred);
		stop();
		resolve(null);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(apply).not.toHaveBeenCalled();
		expect(deferred).not.toHaveBeenCalled();
	});

	it('does not retry once content is shown even if pending work settles', async () => {
		safe.mockReturnValue(false);
		stop = startAutoPwaUpdate('new', safe, apply, deferred);
		await vi.advanceTimersByTimeAsync(500);
		stop();
		safe.mockReturnValue(true);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(apply).not.toHaveBeenCalled();
	});

	it('defers to manual updating after backgrounding during download', async () => {
		let resolve!: (worker: null) => void;
		vi.mocked(preparePwaUpdate).mockReturnValue(new Promise(done => { resolve = done; }));
		stop = startAutoPwaUpdate('new', safe, apply, deferred);
		doc.visibilityState = 'hidden';
		resolve(null);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(apply).not.toHaveBeenCalled();
		expect(deferred).toHaveBeenCalledOnce();
		doc.visibilityState = 'visible';
		await vi.advanceTimersByTimeAsync(5_000);
		expect(apply).not.toHaveBeenCalled();
	});

	it('falls back without a retry loop when installation fails', async () => {
		vi.mocked(preparePwaUpdate).mockRejectedValueOnce(new Error('Offline'));
		stop = startAutoPwaUpdate('new', safe, apply, deferred);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(preparePwaUpdate).toHaveBeenCalledOnce();
		expect(apply).not.toHaveBeenCalled();
		expect(deferred).toHaveBeenCalledOnce();
	});

	it('keeps manual updating when session storage cannot guard a reload', async () => {
		vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('Blocked'); } });
		stop = startAutoPwaUpdate('new', safe, apply, deferred);
		await vi.advanceTimersByTimeAsync(0);
		expect(apply).not.toHaveBeenCalled();
		expect(deferred).toHaveBeenCalledOnce();
	});
});
