import {
	artifactVersion,
	d1Migrations,
	workerBundleGzipBase64,
	workerBundleSha256,
} from 'virtual:crate-cloudflare-artifacts';
import { decodeAndVerifyArtifacts, type CloudflareDeploymentArtifacts } from './deployment-artifacts';

let decodedArtifacts: Promise<CloudflareDeploymentArtifacts> | null = null;

export function loadEmbeddedCloudflareArtifacts(): Promise<CloudflareDeploymentArtifacts> {
	decodedArtifacts ??= decodeAndVerifyArtifacts({
		version: artifactVersion,
		workerBundleGzipBase64,
		workerBundleSha256,
		d1Migrations,
	});
	return decodedArtifacts;
}
