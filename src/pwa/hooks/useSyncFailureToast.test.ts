import { act, createElement, type ContextType } from 'react';
import { renderHook } from '../../test/react-hooks';
import { FeatureNavigationContext } from '../components/FeatureSwitcherButton';
import { beforeEach, expect, it, vi } from 'vitest';
import { useSyncFailureToast } from './useSyncFailureToast';

const showToast = vi.fn();
let visibility: 'visible' | 'hidden';
let active: boolean;
let hook: ReturnType<typeof renderHook<void>> | undefined;
let options: Parameters<typeof useSyncFailureToast>[0];
beforeEach(() => {
	showToast.mockClear(); visibility = 'visible'; active = true; hook = undefined;
});
function render(operationIds: string[], scope: string | null = 'session', ready = true, isCurrent?: () => boolean) {
	options = { scope, ready, operationIds, feature: 'Reading', showToast, isCurrent };
	if (hook) { hook.rerender(); return; }
	hook = renderHook(() => useSyncFailureToast(options), () => {
		Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
	}, children => createElement(FeatureNavigationContext.Provider, { value: {
		section: 'reading', active, toggle: vi.fn(), destination: null, navigate: vi.fn(), dockIndex: null,
		rememberReminderDockIndex: vi.fn(), readingTab: 'inbox', rememberReadingTab: vi.fn(),
	} satisfies ContextType<typeof FeatureNavigationContext> }, children));
}
function visibilityChanged() {
	act(() => { document.dispatchEvent(new window.Event('visibilitychange')); });
}

it('announces a batch once without repeating on refresh or retry', () => {
	render([]);
	expect(showToast).not.toHaveBeenCalled();
	render(['rejected', 'dependent']);
	expect(showToast).toHaveBeenCalledExactlyOnceWith('error', 'Reading changes need attention. Review them in settings.');
	render(['rejected', 'dependent']);
	render([]); // Automatic or manual retry temporarily clears the attention state.
	render(['rejected', 'dependent']);
	expect(showToast).toHaveBeenCalledTimes(1);
	render(['rejected', 'dependent', 'new-failure']);
	expect(showToast).toHaveBeenCalledTimes(2);
});

it('waits until the feature and document are visible', () => {
	active = false;
	render(['failure']);
	expect(showToast).not.toHaveBeenCalled();
	active = true; visibility = 'hidden';
	render(['failure']);
	expect(showToast).not.toHaveBeenCalled();
	visibility = 'visible'; visibilityChanged();
	expect(showToast).toHaveBeenCalledTimes(1);
	visibilityChanged();
	expect(showToast).toHaveBeenCalledTimes(1);
});

it('waits for hydration and keeps announcement identities scoped to the session', () => {
	render(['failure'], 'first', false);
	expect(showToast).not.toHaveBeenCalled();
	render(['failure'], 'first');
	expect(showToast).toHaveBeenCalledTimes(1);
	render(['failure'], null);
	expect(showToast).toHaveBeenCalledTimes(1);
	render(['failure'], 'second');
	expect(showToast).toHaveBeenCalledTimes(2);
});

it('does not announce an old session’s failure after returning to the tab', () => {
	let current = true;
	visibility = 'hidden';
	render(['failure'], 'old-session', true, () => current);
	current = false; visibility = 'visible';
	visibilityChanged();
	expect(showToast).not.toHaveBeenCalled();
});

it('removes visibility listeners when the feature hides or unmounts', () => {
	visibility = 'hidden';
	render(['failure']);
	active = false; render(['failure']);
	visibility = 'visible'; visibilityChanged();
	expect(showToast).not.toHaveBeenCalled();
	active = true; visibility = 'hidden'; render(['failure']);
	hook!.unmount(); visibility = 'visible'; visibilityChanged();
	expect(showToast).not.toHaveBeenCalled();
});
