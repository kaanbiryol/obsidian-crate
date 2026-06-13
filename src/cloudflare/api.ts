/**
 * Cloudflare API helpers for in-plugin setup and infrastructure management.
 */

export type {
	CloudflareCredentials,
	R2Bucket,
	WorkerScript,
	D1Database,
	WorkerBinding,
} from './api-types';
export {
	verifyCredentials,
	verifyToken,
	listAccessibleAccounts,
	buildCloudflareTokenTemplateUrl,
} from './api-auth';
export {
	listR2Buckets,
	createR2Bucket,
	deleteR2Bucket,
	createD1Database,
	listD1Databases,
	deleteD1Database,
	listWorkers,
	deleteWorker,
	getWorkerSubdomain,
	getWorkerBindings,
	queryD1,
} from './api-resources';
export {
	deployWorker,
	redeployWorker,
} from './api-deploy';
export {
	generateAuthToken,
	generateBucketName,
	generateWorkerName,
} from './api-utils';
