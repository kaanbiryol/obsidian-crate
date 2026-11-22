import { DEVELOPMENT_BUILD } from '../../protocol/server-build';
import {
	artifactFingerprint,
	artifactVersion,
	selfHostedFingerprint,
	d1SchemaGzipBase64,
	d1SchemaSha256,
	workerBundleGzipBase64,
	workerBundleSha256,
} from 'virtual:crate-cloudflare-artifacts';
import { decodeAndVerifyArtifacts, type CloudflareDeploymentArtifacts } from './artifacts';

export const EMBEDDED_CLOUDFLARE_ARTIFACT = Object.freeze({
	development: DEVELOPMENT_BUILD ?? undefined,
		version: artifactVersion,
	fingerprint: artifactFingerprint,
	/** A self-hosted server built from the same commit runs this bundle instead. */
	selfHostedFingerprint,
});

/** Decodes per call so the Worker source is released when its operation ends. */
export function loadEmbeddedCloudflareArtifacts(): Promise<CloudflareDeploymentArtifacts> {
	return decodeAndVerifyArtifacts({
		development: DEVELOPMENT_BUILD ?? undefined,
		version: artifactVersion,
		fingerprint: artifactFingerprint,
		workerBundleGzipBase64,
		workerBundleSha256,
		d1SchemaGzipBase64,
		d1SchemaSha256,
	});
}
