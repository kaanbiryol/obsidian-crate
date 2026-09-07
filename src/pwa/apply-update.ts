import { fetchPwaAssetVersion } from './api';

export function waitForWorkerActivation(worker: ServiceWorker): Promise<void> {
	return new Promise((resolve, reject) => {
		let requestedActivation = false;
		const finish = (error?: Error) => {
			clearTimeout(timeout);
			worker.removeEventListener('statechange', check);
			if (error) reject(error);
			else resolve();
		};
		const check = () => {
			if (worker.state === 'installed' && !requestedActivation) {
				requestedActivation = true;
				worker.postMessage({ type: 'CRATE_ACTIVATE_UPDATE' });
			}
			if (worker.state === 'activated') finish();
			else if (worker.state === 'redundant') finish(new Error('The update could not be installed. Please try again.'));
		};
		const timeout = setTimeout(() => finish(new Error('The update timed out. Please try again.')), 20_000);
		worker.addEventListener('statechange', check);
		check();
	});
}

export async function applyPwaUpdate(beforeReload?: () => Promise<void>): Promise<void> {
	const version = await fetchPwaAssetVersion();
	if (!version) throw new Error('Could not check for updates. Please try again.');
	if ('serviceWorker' in navigator) {
		// Reloading alone can return the old worker's cached HTML shell.
		// Register the latest version instead of this client's baked-in version.
		const registration = await navigator.serviceWorker.register(
			`/notifications/sw.js?v=${encodeURIComponent(version)}`,
			{ scope: '/notifications', updateViaCache: 'none' },
		);
		const worker = registration.installing ?? registration.waiting ?? registration.active;
		if (!worker || new URL(worker.scriptURL).searchParams.get('v') !== version) {
			throw new Error('The latest update is not ready. Please try again.');
		}
		// Activation follows precaching and clients.claim in our worker.
		await waitForWorkerActivation(worker);
	}
	await beforeReload?.();
	window.location.reload();
}
