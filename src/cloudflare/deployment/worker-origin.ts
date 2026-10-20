import type { CrateSettings } from '../../plugin/settings';

/** The origin Cloudflare serves a Worker from on the account's workers.dev subdomain. */
export function workersDevOrigin(workerName: string, subdomain: string): string {
	return `https://${workerName}.${subdomain}.workers.dev`;
}

/** Whether the connected server is this vault's managed deployment at its workers.dev origin. */
export function isManagedDeploymentUrl(settings: Pick<CrateSettings, 'workerUrl' | 'cloudflareDeployment'>): boolean {
	const deployment = settings.cloudflareDeployment;
	if (!deployment?.workersSubdomain) return false;
	return settings.workerUrl === workersDevOrigin(deployment.workerName, deployment.workersSubdomain);
}
