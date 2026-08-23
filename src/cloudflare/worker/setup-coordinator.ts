import { corsResponse } from './cors';

/**
 * Compatibility export for deployments that already own the SETUP Durable
 * Object namespace. Device authorization now happens only through Cloudflare
 * OAuth, so the legacy public enrollment coordinator is permanently closed.
 */
export class SetupCoordinator implements DurableObject {
	async fetch(): Promise<Response> {
		return corsResponse({ error: 'Device setup requires Cloudflare authorization' }, 410);
	}
}
