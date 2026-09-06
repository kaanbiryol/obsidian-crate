import type { CloudflareDeploymentMetadata } from './deployment-types';

export interface CloudflareArtifactIdentity {
	version: string;
	fingerprint: string;
}

function semanticVersionCore(version: string): [number, number, number] | null {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
	if (!match) return null;
	const [, major, minor, patch] = match;
	if (major === undefined || minor === undefined || patch === undefined) return null;
	return [Number(major), Number(minor), Number(patch)];
}

function compareVersionCore(left: [number, number, number], right: [number, number, number]): number {
	for (const index of [0, 1, 2] as const) {
		const difference = left[index] - right[index];
		if (difference !== 0) return difference;
	}
	return 0;
}

export function assertDeploymentIsNotDowngrade(deployed: string | null, embedded: string): void {
	if (!deployed) return;
	const from = semanticVersionCore(deployed);
	const to = semanticVersionCore(embedded);
	if (!from || !to || compareVersionCore(to, from) < 0) {
		throw new Error(`This server runs Crate ${deployed}. Update this plugin before deploying; server downgrades are not supported`);
	}
}

export function isCloudflareServerUpdateAvailable(
	deployment: CloudflareDeploymentMetadata,
	embedded: CloudflareArtifactIdentity,
): boolean {
	// A fingerprint is derived only from the deployable Worker, PWA, and D1
	// artifacts. Plugin releases can change independently, so their versions
	// must not by themselves prompt a Cloudflare deployment.
	if (!deployment.lastDeployedVersion) return true;

	const embeddedVersion = semanticVersionCore(embedded.version);
	const deployedVersion = semanticVersionCore(deployment.lastDeployedVersion);
	if (embeddedVersion && deployedVersion) {
		const comparison = compareVersionCore(embeddedVersion, deployedVersion);
		if (comparison < 0) return false;
	}

	if (!deployment.lastDeployedFingerprint) return true;

	return deployment.lastDeployedFingerprint !== embedded.fingerprint;
}
