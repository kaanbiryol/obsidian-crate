import { normalizeVaultName, VAULT_NAME_BINDING } from './vault-name';
import cloudSafetyCompatSource from './worker/cloud-safety-compat.js?raw';
import resetWorkerSource from './worker/reset-worker.js?raw';
import serverDeleteWorkerSource from './worker/server-delete-worker.js?raw';
import { NOTIFICATION_RATE_BINDING, notificationRateNamespace } from './notification-rate-binding';
import { randomBase64Url } from './pkce';
import type { CloudflareDeploymentArtifacts } from './deployment-artifacts';

function concatBytes(parts: Uint8Array[]): ArrayBuffer {
	const length = parts.reduce((total, part) => total + part.byteLength, 0);
	const output = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.byteLength;
	}
	return output.buffer;
}

export function buildWorkerMultipartBody(input: {
	publicOrigin: string;
	vaultName?: string;
	uploadTag?: string;
	artifacts: CloudflareDeploymentArtifacts;
	d1DatabaseId: string;
	r2BucketName: string;
}): { body: ArrayBuffer; contentType: string } {
	const metadata = {
		main_module: 'worker.mjs',
		compatibility_date: '2026-08-18',
		compatibility_flags: ['global_fetch_strictly_public'],
		annotations: {
			'workers/message': `Crate ${input.artifacts.version} ${input.artifacts.fingerprint}`,
			'workers/tag': input.uploadTag ?? 'crate',
		},
		bindings: [
			...(normalizeVaultName(input.vaultName) ? [{ type: 'plain_text', name: VAULT_NAME_BINDING, text: normalizeVaultName(input.vaultName) }] : []),
			{ type: 'plain_text', name: 'CRATE_DEPLOYMENT_FINGERPRINT', text: input.artifacts.fingerprint },
			{ type: 'plain_text', name: 'CRATE_PUBLIC_ORIGIN', text: new URL(input.publicOrigin).origin },
			{ type: 'd1', name: 'DB', id: input.d1DatabaseId },
			{ type: 'r2_bucket', name: 'BUCKET', bucket_name: input.r2BucketName },
			{ type: 'durable_object_namespace', name: 'REMINDER_ALARMS', class_name: 'ReminderAlarm' },
			{ type: 'ratelimit', name: NOTIFICATION_RATE_BINDING, namespace_id: notificationRateNamespace(input.r2BucketName), simple: { limit: 60, period: 60 } },
		],
		exports: {
			ReminderAlarm: { type: 'durable-object', storage: 'sqlite', state: 'created' },
			CloudSafety: { type: 'durable-object', storage: 'sqlite', state: 'created' },
		},
	};
	return buildWorkerModule(metadata, input.artifacts.workerBundle);
}

export function buildResetWorkerMultipartBody(resetId: string, databaseId: string, bucketName: string, alreadyRetired = false): { body: ArrayBuffer; contentType: string } {
	return buildWorkerModule({
		main_module: 'worker.mjs', compatibility_date: '2026-08-18',
		compatibility_flags: ['global_fetch_strictly_public'],
		annotations: { 'workers/message': `Crate reset ${resetId}`, 'workers/tag': 'crate' },
		bindings: [{ type: 'd1', name: 'DB', id: databaseId }, { type: 'r2_bucket', name: 'BUCKET', bucket_name: bucketName },
			{ type: 'plain_text', name: 'CRATE_RESET_ID', text: resetId }],
		exports: {
			CloudSafety: { type: 'durable-object', storage: 'sqlite', state: 'created' },
			...(!alreadyRetired ? { ReminderAlarm: { type: 'durable-object', state: 'deleted' } } : {}),
		},
	}, `${resetWorkerSource}\n${cloudSafetyCompatSource}`);
}

export function buildServerDeletionWorkerMultipartBody(deletionId: string, bucketName: string, tokenHash: string, uploadTag: string): { body: ArrayBuffer; contentType: string } {
	return buildWorkerModule({
		main_module: 'worker.mjs', compatibility_date: '2026-08-18',
		compatibility_flags: ['global_fetch_strictly_public'],
		annotations: { 'workers/message': `Crate deletion ${deletionId}`, 'workers/tag': uploadTag },
		bindings: [{ type: 'r2_bucket', name: 'BUCKET', bucket_name: bucketName },
			{ type: 'plain_text', name: 'CRATE_RESET_ID', text: deletionId },
			{ type: 'plain_text', name: 'CRATE_DELETE_TOKEN_HASH', text: tokenHash },
			{ type: 'plain_text', name: 'CRATE_DELETE_UPLOAD_TAG', text: uploadTag }],
	}, serverDeleteWorkerSource);
}

function buildWorkerModule(metadata: Record<string, unknown>, workerBundle: string): { body: ArrayBuffer; contentType: string } {
	const boundary = `crate-${randomBase64Url(18)}`;
	const encoder = new TextEncoder();
	const parts = [
		encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(metadata)}\r\n`),
		encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="worker.mjs"; filename="worker.mjs"\r\nContent-Type: application/javascript+module\r\n\r\n`),
		encoder.encode(workerBundle),
		encoder.encode(`\r\n--${boundary}--\r\n`),
	];
	return {
		body: concatBytes(parts),
		contentType: `multipart/form-data; boundary=${boundary}`,
	};
}
