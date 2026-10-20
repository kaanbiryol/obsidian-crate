import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { finishPwaUpdateTransition } from './update-transition';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

let root: { dataset: { pwaUpdating?: string } };
let app: { removeAttribute: ReturnType<typeof vi.fn> };
let animations: { transitionProperty: string; finished: Promise<void> }[];
let reducedMotion: boolean;

beforeEach(() => {
	vi.useFakeTimers();
	root = { dataset: { pwaUpdating: 'restore' } };
	app = { removeAttribute: vi.fn() };
	animations = [];
	reducedMotion = false;
	vi.stubGlobal('window', {
		setTimeout, clearTimeout,
		matchMedia: () => ({ matches: reducedMotion }),
	});
	vi.stubGlobal('document', {
		documentElement: root,
		getElementById: (id: string) => id === 'app' ? app : { getAnimations: () => animations },
	});
	vi.stubGlobal('sessionStorage', { removeItem: vi.fn() });
});

afterEach(() => {
	finishPwaUpdateTransition();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

it('keeps content inert past the nominal fade duration until the painted transition finishes', async () => {
	const transition = deferred();
	animations = [{ transitionProperty: 'opacity', finished: transition.promise }];
	finishPwaUpdateTransition({ fade: true });
	await vi.advanceTimersByTimeAsync(400);
	expect(root.dataset.pwaUpdating).toBe('revealing');
	expect(app.removeAttribute).not.toHaveBeenCalled();
	transition.resolve();
	await vi.advanceTimersByTimeAsync(0);
	expect(root.dataset.pwaUpdating).toBeUndefined();
	expect(app.removeAttribute).toHaveBeenCalledExactlyOnceWith('inert');
});

it('ignores completion from a reveal superseded by another update', async () => {
	const first = deferred(), second = deferred();
	animations = [{ transitionProperty: 'opacity', finished: first.promise }];
	finishPwaUpdateTransition({ fade: true });
	root.dataset.pwaUpdating = 'restore';
	animations = [{ transitionProperty: 'opacity', finished: second.promise }];
	finishPwaUpdateTransition({ fade: true });
	first.resolve();
	await vi.advanceTimersByTimeAsync(0);
	expect(root.dataset.pwaUpdating).toBe('revealing');
	expect(app.removeAttribute).not.toHaveBeenCalled();
	second.resolve();
	await vi.advanceTimersByTimeAsync(0);
	expect(root.dataset.pwaUpdating).toBeUndefined();
});

it('recovers when the browser never reports transition completion', async () => {
	animations = [{ transitionProperty: 'opacity', finished: new Promise(() => {}) }];
	finishPwaUpdateTransition({ fade: true });
	await vi.advanceTimersByTimeAsync(1000);
	expect(root.dataset.pwaUpdating).toBeUndefined();
	expect(app.removeAttribute).toHaveBeenCalledExactlyOnceWith('inert');
});

it('finishes immediately for reduced motion or an absent CSS transition', () => {
	reducedMotion = true;
	finishPwaUpdateTransition({ fade: true });
	expect(root.dataset.pwaUpdating).toBeUndefined();
	reducedMotion = false;
	root.dataset.pwaUpdating = 'restore';
	finishPwaUpdateTransition({ fade: true });
	expect(root.dataset.pwaUpdating).toBeUndefined();
});
