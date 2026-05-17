import type {
	CloudflareCredentials,
	CloudflareEnvelope,
	DeployWorkerBindings,
	WorkerDeployment,
} from './api-types';
import { cfRawRequest, cfRequest, formatCloudflareError } from './api-transport';
import { createMultipartBody } from './api-utils';
import { getWorkerSubdomain } from './api-resources';

export async function deployWorker(
	credentials: CloudflareCredentials,
	workerName: string,
	workerScript: string,
	bindings: DeployWorkerBindings
): Promise<WorkerDeployment> {
	const bindingsArray: Record<string, string>[] = [
		{
			type: 'r2_bucket',
			name: 'BUCKET',
			bucket_name: bindings.r2Bucket,
		},
		{
			type: 'secret_text',
			name: 'AUTH_TOKEN',
			text: bindings.authToken,
		},
	];

	if (bindings.d1DatabaseId) {
		bindingsArray.push({
			type: 'd1',
			name: 'DB',
			id: bindings.d1DatabaseId,
		});
		bindingsArray.push({
			type: 'plain_text',
			name: 'CF_DATABASE_ID',
			text: bindings.d1DatabaseId,
		});
	}

	if (bindings.accountId) {
		bindingsArray.push({
			type: 'plain_text',
			name: 'CF_ACCOUNT_ID',
			text: bindings.accountId,
		});
	}

	if (bindings.workerName) {
		bindingsArray.push({
			type: 'plain_text',
			name: 'CF_WORKER_NAME',
			text: bindings.workerName,
		});
	}

	if (bindings.bucketName) {
		bindingsArray.push({
			type: 'plain_text',
			name: 'CF_BUCKET_NAME',
			text: bindings.bucketName,
		});
	}

	if (!bindings.skipDurableObjects) {
		bindingsArray.push({
			type: 'durable_object_namespace',
			name: 'REMINDER_ALARMS',
			class_name: 'ReminderAlarm',
		});
	}

	const metadata: Record<string, unknown> = {
		main_module: 'index.js',
		bindings: bindingsArray,
	};

	if (!bindings.skipDurableObjects) {
		metadata.migrations = {
			tag: 'v1',
			new_sqlite_classes: ['ReminderAlarm'],
		};
	}

	const multipart = createMultipartBody([
		{
			name: 'metadata',
			value: JSON.stringify(metadata),
			contentType: 'application/json',
		},
		{
			name: 'index.js',
			filename: 'index.js',
			value: workerScript,
			contentType: 'application/javascript+module',
		},
	]);

	const deployJson = await cfRawRequest(
		credentials,
		`/accounts/${credentials.accountId}/workers/scripts/${workerName}`,
		{
			method: 'PUT',
			headers: {
				'Content-Type': `multipart/form-data; boundary=${multipart.boundary}`,
			},
			body: multipart.body,
		}
	);

	if (!deployJson || typeof deployJson !== 'object') {
		throw new Error('Worker deployment returned an invalid response');
	}

	const deployData = deployJson as CloudflareEnvelope<{ id: string }>;
	if (!deployData.success) {
		throw formatCloudflareError(200, deployData);
	}

	await cfRequest<unknown>(
		credentials,
		`/accounts/${credentials.accountId}/workers/scripts/${workerName}/subdomain`,
		{
			method: 'POST',
			body: JSON.stringify({ enabled: true }),
		}
	);

	const subdomain = await getWorkerSubdomain(credentials);

	return {
		id: deployData.result.id,
		url: `https://${workerName}.${subdomain}.workers.dev`,
	};
}

export async function redeployWorker(
	credentials: CloudflareCredentials,
	workerName: string,
	workerScript: string
): Promise<void> {
	const metadata = {
		main_module: 'index.js',
		keep_bindings: ['r2_bucket', 'secret_text', 'd1', 'plain_text', 'durable_object_namespace'],
	};

	const multipart = createMultipartBody([
		{
			name: 'metadata',
			value: JSON.stringify(metadata),
			contentType: 'application/json',
		},
		{
			name: 'index.js',
			filename: 'index.js',
			value: workerScript,
			contentType: 'application/javascript+module',
		},
	]);

	const json = await cfRawRequest(
		credentials,
		`/accounts/${credentials.accountId}/workers/scripts/${workerName}`,
		{
			method: 'PUT',
			headers: {
				'Content-Type': `multipart/form-data; boundary=${multipart.boundary}`,
			},
			body: multipart.body,
		}
	);

	if (!json || typeof json !== 'object') {
		throw new Error('Worker redeploy returned an invalid response');
	}

	const payload = json as CloudflareEnvelope<{ id?: string }>;
	if (!payload.success) {
		throw formatCloudflareError(200, payload);
	}
}
