import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { whenUpdateLayoutSettles } from './update-layout-readiness';

let headerTop = 0;

beforeEach(() => {
	vi.useFakeTimers();
	headerTop = 0;
	vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 16));
	vi.stubGlobal('cancelAnimationFrame', clearTimeout);
	vi.stubGlobal('window', { innerWidth: 390, innerHeight: 844 });
	vi.stubGlobal('document', {
		fonts: { status: 'loaded' },
		querySelectorAll: () => [{ getBoundingClientRect: () => ({ x: 0, y: headerTop, width: 390, height: 100 }) }],
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

it('restarts the settling period when startup geometry changes', () => {
	const ready = vi.fn();
	whenUpdateLayoutSettles(ready);
	vi.advanceTimersByTime(160);
	headerTop = 59;
	vi.advanceTimersByTime(160);
	expect(ready).not.toHaveBeenCalled();
	vi.advanceTimersByTime(64);
	expect(ready).toHaveBeenCalledOnce();
});

it('reveals the app within the limit even if layout keeps changing', () => {
	const ready = vi.fn();
	whenUpdateLayoutSettles(ready);
	for (let step = 0; step < 126; step++) {
		headerTop += 1;
		vi.advanceTimersByTime(16);
	}
	expect(ready).toHaveBeenCalledOnce();
});

it('cancels a pending reveal when readiness changes or the app unmounts', () => {
	const ready = vi.fn();
	const cancel = whenUpdateLayoutSettles(ready);
	vi.advanceTimersByTime(32);
	cancel();
	vi.advanceTimersByTime(2_000);
	expect(ready).not.toHaveBeenCalled();
});
