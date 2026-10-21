import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderHook } from '../../test/react-hooks';
import { applyPwaUpdate, preparePwaUpdate } from './apply-update';
import { usePwaUpdate } from './usePwaUpdate';

vi.mock('./apply-update', () => ({ applyPwaUpdate: vi.fn(), preparePwaUpdate: vi.fn(async () => null) }));
vi.mock('./update-transition', () => ({
	PWA_UPDATE_PROGRESS_SETTLE_MS: 450,
	advancePwaUpdateProgress: vi.fn(),
	finishPwaUpdateTransition: vi.fn(),
	preparePwaUpdateTransition: vi.fn(),
	showPwaUpdateTransition: vi.fn(),
}));

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); });

function render() {
	return renderHook(() => usePwaUpdate(vi.fn(), true, {
		version: 'new', checkComplete: true, canApply: () => true, canManuallyApply: () => true,
	}), () => {
		vi.stubGlobal('navigator', { onLine: true });
		Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
		const memory = new Map<string, string>();
		vi.stubGlobal('sessionStorage', {
			getItem: (key: string) => memory.get(key) ?? null,
			setItem: (key: string, value: string) => memory.set(key, value),
		});
	});
}

it('reports updating only once a launch update starts applying, and the launch deadline does not cut it off', async () => {
	let finish!: (applied: boolean) => void;
	let options!: NonNullable<Parameters<typeof applyPwaUpdate>[1]>;
	vi.mocked(applyPwaUpdate).mockImplementation((_, next = {}) => {
		options = next;
		return new Promise(resolve => { finish = resolve; });
	});
	let downloaded!: () => void;
	vi.mocked(preparePwaUpdate).mockReturnValue(new Promise(resolve => { downloaded = () => resolve(null); }));
	const hook = render();
	expect(hook.current).toMatchObject({ launchPending: true, updating: false });

	await act(async () => { downloaded(); await vi.advanceTimersByTimeAsync(0); });
	expect(hook.current).toMatchObject({ launchPending: true, updating: true });

	await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
	expect(hook.current.launchPending).toBe(true);
	expect(options.canApply?.()).toBe(true);

	await act(async () => { finish(false); await vi.advanceTimersByTimeAsync(0); });
	expect(hook.current).toMatchObject({ launchPending: false, updating: false });
});

it('ends the launch window without an updating screen when the download outlasts the deadline', async () => {
	vi.mocked(preparePwaUpdate).mockReturnValue(new Promise(() => {}));
	const hook = render();
	await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
	expect(hook.current).toMatchObject({ launchPending: false, updating: false });
	expect(applyPwaUpdate).not.toHaveBeenCalled();
});
