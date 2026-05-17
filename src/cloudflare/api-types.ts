export interface CloudflareEnvelope<T> {
	success: boolean;
	errors?: Array<{ message?: string }>;
	result: T;
}

export interface CloudflareErrorBody {
	success?: boolean;
	errors?: Array<{ message?: string }>;
}

export interface RawRequestOptions {
	method?: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
	contentType?: string;
}

export interface CloudflareCredentials {
	accountId: string;
	apiToken: string;
}

export interface CloudflareAccount {
	id: string;
	name: string;
}

export interface R2Bucket {
	name: string;
	creation_date: string;
}

export interface WorkerScript {
	id: string;
}

export interface D1Database {
	uuid: string;
	name: string;
}

export interface WorkerDeployment {
	id: string;
	url: string;
}

export interface DeployWorkerBindings {
	r2Bucket: string;
	authToken: string;
	d1DatabaseId?: string;
	accountId?: string;
	workerName?: string;
	bucketName?: string;
	skipDurableObjects?: boolean;
}

export interface WorkerBinding {
	type: string;
	name: string;
	text?: string;
	bucket_name?: string;
	id?: string;
}
