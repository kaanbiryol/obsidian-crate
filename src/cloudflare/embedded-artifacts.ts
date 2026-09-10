import {
	artifactFingerprint,
	artifactVersion,
	d1SchemaGzipBase64,
	d1SchemaSha256,
	workerBundleGzipBase64,
	workerBundleSha256,
} from 'virtual:crate-cloudflare-artifacts';
import { decodeAndVerifyArtifacts, type CloudflareDeploymentArtifacts } from './deployment-artifacts';

let decodedArtifacts: Promise<CloudflareDeploymentArtifacts> | null = null;

export const EMBEDDED_CLOUDFLARE_ARTIFACT = Object.freeze({
	version: artifactVersion,
	fingerprint: artifactFingerprint,
});

export function loadEmbeddedCloudflareArtifacts(): Promise<CloudflareDeploymentArtifacts> {
	decodedArtifacts ??= decodeAndVerifyArtifacts({
		version: artifactVersion,
		fingerprint: artifactFingerprint,
		workerBundleGzipBase64,
		workerBundleSha256,
		d1SchemaGzipBase64,
		d1SchemaSha256,
	});
	return decodedArtifacts;
}
