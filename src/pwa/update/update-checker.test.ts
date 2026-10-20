import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startUpdateChecks } from './update-checker';

const AN_HOUR = 60 * 60_000;

describe('app-wide update checks', () => {
	let windowEvents: EventTarget;
	let documentEvents: EventTarget;
	let online: boolean;
	let visible: boolean;
	let stop: (() => void) | undefined;
	beforeEach(() => {
		vi.useFakeTimers();
		online = true; visible = true;
		windowEvents = new EventTarget(); documentEvents = new EventTarget();
		vi.stubGlobal('window', Object.assign(windowEvents, { setInterval, clearInterval }));
		Object.defineProperty(documentEvents, 'visibilityState', { get: () => visible ? 'visible' : 'hidden' });
		vi.stubGlobal('document', documentEvents);
		vi.stubGlobal('navigator', { get onLine() { return online; } });
	});
	afterEach(() => { stop?.(); vi.unstubAllGlobals(); vi.useRealTimers(); });
	it('checks at launch and on foreground/pageshow/reconnect, never on a timer', async () => {
		const check = vi.fn(async () => {});
		stop = startUpdateChecks(check);
		await vi.advanceTimersByTimeAsync(0);
		expect(check).toHaveBeenCalledTimes(1);
		// Before: one more check every five minutes while visible.
		await vi.advanceTimersByTimeAsync(AN_HOUR);
		expect(check).toHaveBeenCalledTimes(1);
		for (const [target, event] of [[documentEvents, 'visibilitychange'], [windowEvents, 'pageshow'], [windowEvents, 'online']] as const) {
			target.dispatchEvent(new Event(event));
			await vi.advanceTimersByTimeAsync(0);
		}
		expect(check).toHaveBeenCalledTimes(4);
	});
	it('skips hidden/offline checks and removes listeners on cleanup', async () => {
		visible = false;
		const check = vi.fn(async () => {});
		stop = startUpdateChecks(check);
		await vi.advanceTimersByTimeAsync(AN_HOUR);
		visible = true; online = false;
		documentEvents.dispatchEvent(new Event('visibilitychange'));
		await vi.advanceTimersByTimeAsync(AN_HOUR);
		expect(check).not.toHaveBeenCalled();
		online = true;
		windowEvents.dispatchEvent(new Event('online'));
		await vi.advanceTimersByTimeAsync(0);
		expect(check).toHaveBeenCalledOnce();
		stop();
		windowEvents.dispatchEvent(new Event('pageshow'));
		documentEvents.dispatchEvent(new Event('visibilitychange'));
		await vi.advanceTimersByTimeAsync(AN_HOUR);
		expect(check).toHaveBeenCalledOnce();
	});
	it('coalesces overlapping events and recovers after a failed request', async () => {
		let reject!: (error: Error) => void;
		const check = vi.fn().mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; })).mockResolvedValue(undefined);
		stop = startUpdateChecks(check);
		windowEvents.dispatchEvent(new Event('pageshow'));
		windowEvents.dispatchEvent(new Event('online'));
		await vi.advanceTimersByTimeAsync(0);
		expect(check).toHaveBeenCalledOnce();
		reject(new Error('unavailable'));
		await vi.advanceTimersByTimeAsync(0);
		documentEvents.dispatchEvent(new Event('visibilitychange'));
		await vi.advanceTimersByTimeAsync(0);
		expect(check).toHaveBeenCalledTimes(2);
	});
});
