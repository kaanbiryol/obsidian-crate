import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, vi } from 'vitest';

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.unstubAllGlobals();
});

/** Real React effects and renders in a lightweight DOM; browser focus is tested separately. */
export function renderHook<T>(useHook: () => T) {
	const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
	vi.stubGlobal('window', window);
	vi.stubGlobal('document', document);
	vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
	const root = createRoot(document.getElementById('root')!);
	let current: T;
	let mounted = true;
	function Harness() {
		current = useHook();
		return null;
	}
	const rerender = () => { act(() => root.render(createElement(Harness))); };
	const unmount = () => {
		if (!mounted) return;
		act(() => root.unmount());
		mounted = false;
	};
	cleanups.push(unmount);
	rerender();
	return { get current() { return current!; }, rerender, unmount };
}
