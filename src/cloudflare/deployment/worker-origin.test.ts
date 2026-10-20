import { expect, it } from 'vitest';
import { isManagedDeploymentUrl, workersDevOrigin } from './worker-origin';
import { createCloudflareDeploymentMetadata } from './target';

it('builds the workers.dev origin for a Worker', () => {
	expect(workersDevOrigin('crate-0123456789abcdef', 'team')).toBe('https://crate-0123456789abcdef.team.workers.dev');
});

it('recognizes only the managed deployment origin', () => {
	const deployment = { ...createCloudflareDeploymentMetadata(), workersSubdomain: 'team' };
	const managed = workersDevOrigin(deployment.workerName, 'team');
	expect(isManagedDeploymentUrl({ workerUrl: managed, cloudflareDeployment: deployment })).toBe(true);
	expect(isManagedDeploymentUrl({ workerUrl: 'https://crate.example', cloudflareDeployment: deployment })).toBe(false);
	expect(isManagedDeploymentUrl({ workerUrl: managed, cloudflareDeployment: { ...deployment, workersSubdomain: null } })).toBe(false);
	expect(isManagedDeploymentUrl({ workerUrl: managed, cloudflareDeployment: null })).toBe(false);
});
