import { fetchPwaAssetVersion } from './api';

function waitForWorker(worker: ServiceWorker, activate: boolean): Promise<void> {
	return new Promise((resolve, reject) => {
		let requestedActivation = false;
		const finish = (error?: Error) => {
			clearTimeout(timeout);
			worker.removeEventListener('statechange', check);
			if (error) reject(error);
			else resolve();
		};
		const check = () => {
			if (activate && worker.state === 'installed' && !requestedActivation) {
				requestedActivation = true;
				worker.postMessage({ type: 'CRATE_ACTIVATE_UPDATE' });
			}
			if (worker.state === 'activated' || (!activate && (worker.state === 'installed' || worker.state === 'activating'))) finish();
			else if (worker.state === 'redundant') finish(new Error('The update could not be installed. Please try again.'));
		};
		const timeout = setTimeout(() => finish(new Error('The update timed out. Please try again.')), 20_000);
		worker.addEventListener('statechange', check);
		check();
	});
}

export function waitForWorkerActivation(worker: ServiceWorker): Promise<void> {
	return waitForWorker(worker, true);
}

/** Precache without replacing the worker serving an open editor. */
export async function preparePwaUpdate(version: string): Promise<ServiceWorker | null> {
	if (!('serviceWorker' in navigator)) return null;
	const registration = await navigator.serviceWorker.register(
		`/notifications/sw.js?v=${encodeURIComponent(version)}`,
		{ scope: '/notifications', updateViaCache: 'none' },
	);
	const worker = registration.installing ?? registration.waiting ?? registration.active;
	if (!worker || new URL(worker.scriptURL).searchParams.get('v') !== version) {
		throw new Error('The latest update is not ready. Please try again.');
	}
	await waitForWorker(worker, false);
	return worker;
}

export async function applyPwaUpdate(beforeReload?: () => Promise<void>, options: {
	version?: string;
	canApply?: () => boolean;
	beforeNavigation?: () => boolean;
} = {}): Promise<boolean> {
	const version = options.version ?? await fetchPwaAssetVersion();
	if (!version) throw new Error('Could not check for updates. Please try again.');
	const worker = await preparePwaUpdate(version);
	// The user may have started editing or backgrounded the iPhone during download.
	if (options.canApply && !options.canApply()) return false;
	if (worker) await waitForWorkerActivation(worker);
	if (options.canApply && !options.canApply()) return false;
	await beforeReload?.();
	// Recheck after the transition's async paint, including a suspended iOS timer.
	if (options.canApply && !options.canApply()) return false;
	if (options.beforeNavigation && !options.beforeNavigation()) return false;
	window.location.reload();
	return true;
}
