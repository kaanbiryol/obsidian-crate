/** Non-secret identifiers used to make deployment retries converge. */
export interface CloudflareDeploymentMetadata {
	deploymentId: string;
	accountId: string | null;
	accountName: string | null;
	workerName: string;
	d1DatabaseName: string;
	d1DatabaseId: string | null;
	r2BucketName: string;
	workersSubdomain: string | null;
	lastDeployedVersion: string | null;
	lastDeployedFingerprint: string | null;
}
