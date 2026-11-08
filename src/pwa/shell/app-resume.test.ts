import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { onAppResume } from './app-resume';

let windowEvents: EventTarget, documentEvents: EventTarget, visible: boolean;
beforeEach(() => {
	visible = true;
	windowEvents = new EventTarget(); documentEvents = new EventTarget();
	Object.defineProperty(documentEvents, 'visibilityState', { get: () => visible ? 'visible' : 'hidden' });
	vi.stubGlobal('window', windowEvents);
	vi.stubGlobal('document', documentEvents);
});
afterEach(() => { vi.unstubAllGlobals(); });

it('reports reconnecting and returning to the foreground, but not hiding', () => {
	const listener = vi.fn();
	const stop = onAppResume(listener);
	windowEvents.dispatchEvent(new Event('online'));
	windowEvents.dispatchEvent(new Event('pageshow'));
	documentEvents.dispatchEvent(new Event('visibilitychange'));
	visible = false;
	documentEvents.dispatchEvent(new Event('visibilitychange'));
	windowEvents.dispatchEvent(new Event('focus'));
	expect(listener.mock.calls).toEqual([['online'], ['foreground'], ['foreground']]);
	stop();
	visible = true;
	windowEvents.dispatchEvent(new Event('online'));
	windowEvents.dispatchEvent(new Event('pageshow'));
	documentEvents.dispatchEvent(new Event('visibilitychange'));
	expect(listener).toHaveBeenCalledTimes(3);
});
