declare module 'virtual:crate-cloudflare-artifacts' {
	export const artifactVersion: string;
	export const workerBundleGzipBase64: string;
	export const workerBundleSha256: string;
	export const artifactFingerprint: string;
	/** The self-hosted server's Worker bundle from the same commit, which is not embedded. */
	export const selfHostedFingerprint: string;
	export const d1SchemaGzipBase64: string;
	export const d1SchemaSha256: string;
}
