import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSyncFailureToast } from './useSyncFailureToast';

const hooks = vi.hoisted(() => ({
	active: true,
	ref: undefined as { current: unknown } | undefined,
	cleanup: undefined as (() => void) | undefined,
}));
vi.mock('react', () => ({
	useContext: () => ({ active: hooks.active }),
	useRef: (initial: unknown) => hooks.ref ??= { current: initial },
	useEffect: (effect: () => (() => void) | undefined) => { hooks.cleanup?.(); hooks.cleanup = effect(); },
}));
vi.mock('../components/FeatureSwitcherButton', () => ({ FeatureNavigationContext: {} }));
const showToast = vi.fn();
let visibility: 'visible' | 'hidden';
let listeners: Set<() => void>;
beforeEach(() => {
	hooks.active = true; hooks.ref = undefined; hooks.cleanup = undefined;
	showToast.mockClear(); visibility = 'visible'; listeners = new Set();
	vi.stubGlobal('document', {
		get visibilityState() { return visibility; },
		addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
		removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
	});
});
afterEach(() => { hooks.cleanup?.(); vi.unstubAllGlobals(); });
function render(operationIds: string[], scope: string | null = 'session', ready = true, isCurrent?: () => boolean) {
	// eslint-disable-next-line react-hooks/rules-of-hooks -- This harness runs mocked React effects and retains refs across renders.
	useSyncFailureToast({ scope, ready, operationIds, feature: 'Reading', showToast, isCurrent });
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
	hooks.active = false;
	render(['failure']);
	expect(showToast).not.toHaveBeenCalled();
	hooks.active = true; visibility = 'hidden';
	render(['failure']);
	expect(showToast).not.toHaveBeenCalled();
	visibility = 'visible'; listeners.forEach(listener => listener());
	expect(showToast).toHaveBeenCalledTimes(1);
	listeners.forEach(listener => listener());
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
	listeners.forEach(listener => listener());
	expect(showToast).not.toHaveBeenCalled();
});
