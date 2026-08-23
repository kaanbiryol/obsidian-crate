import type { CloudflareDeploymentMetadata } from '../plugin/types';

export interface CloudflareArtifactIdentity {
	version: string;
	fingerprint: string;
}

function semanticVersionCore(version: string): [number, number, number] | null {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
	if (!match) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersionCore(left: [number, number, number], right: [number, number, number]): number {
	for (let index = 0; index < left.length; index++) {
		const difference = left[index] - right[index];
		if (difference !== 0) return difference;
	}
	return 0;
}

export function isCloudflareServerUpdateAvailable(
	deployment: CloudflareDeploymentMetadata,
	embedded: CloudflareArtifactIdentity,
): boolean {
	if (!deployment.lastDeployedVersion) return true;

	const embeddedVersion = semanticVersionCore(embedded.version);
	const deployedVersion = semanticVersionCore(deployment.lastDeployedVersion);
	if (embeddedVersion && deployedVersion) {
		const comparison = compareVersionCore(embeddedVersion, deployedVersion);
		if (comparison < 0) return false;
		if (comparison > 0) return true;
	} else if (embedded.version !== deployment.lastDeployedVersion) {
		return true;
	}

	return deployment.lastDeployedFingerprint !== embedded.fingerprint;
}
