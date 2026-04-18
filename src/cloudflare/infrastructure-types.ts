import type {
	CloudflareCredentials,
	D1Database,
	R2Bucket,
	WorkerScript,
} from './api';

export type DiagnosticStatus = 'pass' | 'fail' | 'warn';

export interface DiagnosticResult {
	name: string;
	status: DiagnosticStatus;
	message: string;
}

export interface QuickSetupInput {
	accountId: string;
	apiToken: string;
	bucketName?: string;
	workerName?: string;
}

export interface QuickSetupResult {
	workerUrl: string;
	authToken: string;
	bucketName: string;
	workerName: string;
	databaseId: string;
	bucketCreated: boolean;
}

export interface RedeployInput {
	accountId: string;
	apiToken: string;
	workerName: string;
}

export interface DiagnosticsInput {
	workerUrl?: string;
	authToken?: string;
	accountId?: string;
	apiToken?: string;
	workerName?: string;
	bucketName?: string;
	databaseId?: string;
}

export interface ResetInput {
	accountId: string;
	apiToken: string;
	workerName?: string;
	bucketName?: string;
	databaseId?: string;
	includeCratePrefixed?: boolean;
}

export interface ResetResult {
	deleted: string[];
	failed: string[];
}

export interface CrateResources {
	buckets: R2Bucket[];
	workers: WorkerScript[];
	databases: D1Database[];
}

export interface DiscoverCrateResourcesInput {
	accountId: string;
	apiToken: string;
	includeCratePrefixed?: boolean;
	workerName?: string;
	bucketName?: string;
	databaseId?: string;
}

export type ProgressCallback = (message: string) => void;

export interface WorkerTokenConfig {
	workerUrl: string;
	workerName: string;
	bucketName: string;
	databaseId: string;
}

export type { CloudflareCredentials };
