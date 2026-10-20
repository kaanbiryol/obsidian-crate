import type { ServiceWorkerConfig } from '../../../pwa/service-worker/config';
import { PWA_ASSET_VERSION } from '../../../pwa/shell/version';
import { PWA_CLIENT_ASSETS, PWA_ON_DEMAND_ASSETS } from './client-bundle';

declare const __CRATE_SERVICE_WORKER_JS__: string | undefined;
const runtime = typeof __CRATE_SERVICE_WORKER_JS__ === 'string' ? __CRATE_SERVICE_WORKER_JS__
	: 'throw new Error("Crate service worker was not generated before build.");';
const config: ServiceWorkerConfig = {
	version: PWA_ASSET_VERSION,
	chunkUrls: Object.keys(PWA_CLIENT_ASSETS).filter(name => name !== 'app.js' && !PWA_ON_DEMAND_ASSETS.includes(name)).map(name => `/notifications/assets/${name}`),
};

export const SERVICE_WORKER_JS = `${runtime}\ncrateServiceWorker.initialize(self, ${JSON.stringify(config)});`;
