import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchPwaAssetVersion } from './api';
import { applyPwaUpdate, preparePwaUpdate, waitForWorkerActivation } from './apply-update';

vi.mock('./api', () => ({ fetchPwaAssetVersion: vi.fn() }));

class UpdateWorker extends EventTarget {
	state: ServiceWorkerState = 'installing';
	postMessage = vi.fn();
	scriptURL = 'https://crate.test/notifications/sw.js?v=new';
	transition(state: ServiceWorkerState) {
		this.state = state;
		this.dispatchEvent(new Event('statechange'));
	}
}

describe('reliable PWA updates', () => {
	const reload = vi.fn();
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(fetchPwaAssetVersion).mockResolvedValue('new');
		vi.stubGlobal('window', { location: { reload } });
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it('waits for the latest worker to activate before reloading', async () => {
		const worker = new UpdateWorker();
		const register = vi.fn().mockResolvedValue({ installing: worker });
		vi.stubGlobal('navigator', { serviceWorker: { register } });
		const update = applyPwaUpdate();
		await vi.waitFor(() => expect(register).toHaveBeenCalled());
		expect(register).toHaveBeenCalledWith('/notifications/sw.js?v=new', {
			scope: '/notifications', updateViaCache: 'none',
		});
		worker.transition('installed');
		await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith({ type: 'CRATE_ACTIVATE_UPDATE' }));
		expect(reload).not.toHaveBeenCalled();
		worker.transition('activated');
		await update;
		expect(reload).toHaveBeenCalledOnce();
	});

	it('downloads without activating while an editor is open', async () => {
		const worker = new UpdateWorker();
		vi.stubGlobal('navigator', { serviceWorker: { register: vi.fn().mockResolvedValue({ installing: worker }) } });
		const prepared = preparePwaUpdate('new');
		worker.transition('installed');
		await prepared;
		expect(worker.postMessage).not.toHaveBeenCalled();
		await expect(applyPwaUpdate(undefined, { version: 'new', canApply: () => false })).resolves.toBe(false);
		expect(worker.postMessage).not.toHaveBeenCalled();
		expect(reload).not.toHaveBeenCalled();
	});

	it('defers if the app becomes unsafe during activation', async () => {
		const worker = new UpdateWorker();
		worker.state = 'installed';
		vi.stubGlobal('navigator', { serviceWorker: { register: vi.fn().mockResolvedValue({ waiting: worker }) } });
		let safe = true;
		const beforeReload = vi.fn();
		const update = applyPwaUpdate(beforeReload, { canApply: () => safe });
		await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalled());
		safe = false;
		worker.transition('activated');
		await expect(update).resolves.toBe(false);
		expect(beforeReload).not.toHaveBeenCalled();
		expect(reload).not.toHaveBeenCalled();
	});

	it('rechecks visibility after the reload transition and does not mark a cancelled reload', async () => {
		vi.stubGlobal('navigator', {});
		let safe = true;
		const beforeNavigation = vi.fn(() => true);
		await expect(applyPwaUpdate(async () => { safe = false; }, {
			canApply: () => safe, beforeNavigation,
		})).resolves.toBe(false);
		expect(beforeNavigation).not.toHaveBeenCalled();
		expect(reload).not.toHaveBeenCalled();
	});

	it('does not reload an outdated worker or failed registration', async () => {
		const worker = new UpdateWorker();
		worker.scriptURL = 'https://crate.test/notifications/sw.js?v=old';
		worker.state = 'activated';
		const register = vi.fn().mockResolvedValue({ active: worker });
		vi.stubGlobal('navigator', { serviceWorker: { register } });
		await expect(applyPwaUpdate()).rejects.toThrow('not ready');
		register.mockRejectedValueOnce(new Error('Offline'));
		await expect(applyPwaUpdate()).rejects.toThrow('Offline');
		expect(reload).not.toHaveBeenCalled();
	});

	it('covers the reload only after activation and waits for the transition', async () => {
		const worker = new UpdateWorker();
		vi.stubGlobal('navigator', { serviceWorker: { register: vi.fn().mockResolvedValue({ installing: worker }) } });
		let finishTransition!: () => void;
		const beforeReload = vi.fn(() => new Promise<void>(resolve => { finishTransition = resolve; }));
		const update = applyPwaUpdate(beforeReload);
		await vi.waitFor(() => expect(worker.state).toBe('installing'));
		expect(beforeReload).not.toHaveBeenCalled();
		worker.transition('activated');
		await vi.waitFor(() => expect(beforeReload).toHaveBeenCalledOnce());
		expect(reload).not.toHaveBeenCalled();
		finishTransition();
		await update;
		expect(reload).toHaveBeenCalledOnce();
	});

	it('leaves the current screen available when checking for an update fails', async () => {
		vi.mocked(fetchPwaAssetVersion).mockRejectedValueOnce(new Error('Offline'));
		const beforeReload = vi.fn();
		await expect(applyPwaUpdate(beforeReload)).rejects.toThrow('Offline');
		expect(beforeReload).not.toHaveBeenCalled();
		expect(reload).not.toHaveBeenCalled();
	});

	it('reports installation failure and removes its event listener', async () => {
		const worker = new UpdateWorker();
		const remove = vi.spyOn(worker, 'removeEventListener');
		const activation = waitForWorkerActivation(worker as unknown as ServiceWorker);
		worker.transition('redundant');
		await expect(activation).rejects.toThrow('could not be installed');
		expect(remove).toHaveBeenCalledWith('statechange', expect.any(Function));
	});

	it('reports an activation timeout', async () => {
		vi.useFakeTimers();
		const worker = new UpdateWorker();
		const activation = waitForWorkerActivation(worker as unknown as ServiceWorker);
		const rejected = expect(activation).rejects.toThrow('timed out');
		await vi.advanceTimersByTimeAsync(20_000);
		await rejected;
	});

	it('requires a successful version check even without service worker support', async () => {
		vi.stubGlobal('navigator', {});
		vi.mocked(fetchPwaAssetVersion).mockResolvedValueOnce(null);
		await expect(applyPwaUpdate()).rejects.toThrow('Could not check');
		expect(reload).not.toHaveBeenCalled();
		await applyPwaUpdate();
		expect(reload).toHaveBeenCalledOnce();
	});
});
