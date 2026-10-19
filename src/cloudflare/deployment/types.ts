export type DeploymentIntent = 'reconnect' | 'connect' | 'switch' | 'create' | 'update' | 'reset' | 'delete';
export type SavedDeploymentIntent = Exclude<DeploymentIntent, 'switch' | 'create'>;

export function supportsSavedAuthorization(intent: DeploymentIntent): intent is SavedDeploymentIntent {
	return intent !== 'switch' && intent !== 'create';
}

export type CloudflareDeploymentResult =
	| { status: 'deployed'; workerUrl: string; accountName: string }
	| { status: 'deleted'; accountName: string };

/** Non-secret identifiers used to make deployment retries converge. */
export interface CloudflareDeploymentMetadata {
	deploymentId: string;
	vaultName?: string;
	accountId: string | null;
	accountName: string | null;
	workerName: string;
	d1DatabaseName: string;
	d1DatabaseId: string | null;
	r2BucketName: string;
	workersSubdomain: string | null;
	/** Last verified revision, for display only; never authorizes an update. */
	lastKnownRevision?: number;
	lastDeployedVersion: string | null;
	lastDeployedFingerprint: string | null;
	/** Terminal resource deletion; independent of application schema and releases. */
	deletion?: {
		id: string;
		phase: 'removing-worker' | 'clearing-bucket' | 'removing-database' | 'removing-helper' | 'complete';
		databaseId: string;
		bucketCreatedAt: string | null;
		workerCreatedAt: string | null;
		helperName: string;
		/** Provider receipt for an uncertain helper upload when D1 is already absent. */
		helperUploadPending?: string;
	};
	reset?: {
		id: string;
		phase: 'clearing' | 'rebuilding';
		deleteOnly?: true;
		databaseId: string;
		bucketCreatedAt: string;
		namespaceId: string;
	};
}

/** Authorization-independent intent and target captured when an operation starts. */
export interface DeploymentRequest {
	metadata: CloudflareDeploymentMetadata;
	discoverExisting: boolean;
	originalMetadata: string;
	intent: DeploymentIntent;
}
