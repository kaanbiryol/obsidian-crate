import { afterEach, expect, it, vi } from 'vitest';

vi.mock('./shadowStyles', () => ({ attachPluginStylesheet: vi.fn(async () => {}) }));
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render: vi.fn(), unmount: vi.fn() }) }));
afterEach(() => { vi.unstubAllGlobals(); });

function host() {
	const classList = { contains: () => false, toggle: vi.fn(), add: vi.fn() };
	const mountPoint = { classList, dataset: {}, className: '', doc: { body: { classList } } };
	return { isConnected: true, doc: { body: { classList } }, attachShadow: () => ({ createDiv: () => mountPoint }) };
}

it('stops following theme changes when the view unmounts', async () => {
	const disconnect = vi.fn();
	vi.stubGlobal('MutationObserver', class { observe() {} disconnect = disconnect; });
	const { createShadowReactMount } = await import('./shadowReactMount');
	const mount = await createShadowReactMount({} as never, host() as never);
	expect(disconnect).not.toHaveBeenCalled();
	// Before: the observer stayed registered on the body until a later theme change.
	mount!.unmount();
	expect(disconnect).toHaveBeenCalledOnce();
	expect(await createShadowReactMount({} as never, host() as never, { isActive: () => false })).toBeNull();
	expect(disconnect).toHaveBeenCalledTimes(2);
});
