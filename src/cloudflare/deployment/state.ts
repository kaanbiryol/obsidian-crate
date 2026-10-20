import { isRecord, isSha256Hex } from '../../platform/validation';
import { normalizeVaultName } from '../vault-name';
import type { CloudflareDeploymentMetadata } from './types';

function normalizeString(value: unknown, fallback = ''): string {
	return typeof value === 'string' ? value.trim() : fallback;
}

function normalizeNullableString(value: unknown): string | null {
	if (typeof value !== 'string') {
		return null;
	}

	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/** Normalize persisted deployment and recovery metadata without changing its storage format. */
export function normalizeCloudflareDeployment(value: unknown): CloudflareDeploymentMetadata | null {
	if (!isRecord(value)) {
		return null;
	}

	const deploymentId = normalizeString(value.deploymentId).toLowerCase();
	const workerName = normalizeString(value.workerName).toLowerCase();
	const d1DatabaseName = normalizeString(value.d1DatabaseName).toLowerCase();
	const r2BucketName = normalizeString(value.r2BucketName).toLowerCase();
	if (!/^[a-f0-9]{16}$/.test(deploymentId)
		|| !/^crate-[a-f0-9]{16}$/.test(workerName)
		|| !/^crate-[a-f0-9]{16}$/.test(d1DatabaseName)
		|| !/^crate-[a-f0-9]{16}$/.test(r2BucketName)) {
		return null;
	}

	const accountId = normalizeNullableString(value.accountId);
	const d1DatabaseId = normalizeNullableString(value.d1DatabaseId);
	const workersSubdomain = normalizeNullableString(value.workersSubdomain);
	const normalizedFingerprint = normalizeNullableString(value.lastDeployedFingerprint)?.toLowerCase() ?? null;
	const lastDeployedFingerprint = normalizedFingerprint && isSha256Hex(normalizedFingerprint)
		? normalizedFingerprint
		: null;
	if (accountId !== null && !/^[a-f0-9]{32}$/i.test(accountId)) {
		return null;
	}
	if (d1DatabaseId !== null && !/^[a-f0-9-]{32,36}$/i.test(d1DatabaseId)) {
		return null;
	}
	if (workersSubdomain !== null && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(workersSubdomain)) {
		return null;
	}
	let deletion: CloudflareDeploymentMetadata['deletion'];
	if (value.deletion !== undefined) {
		const job = value.deletion;
		if (!isRecord(job) || typeof job.id !== 'string' || !/^[a-f0-9]{32}$/.test(job.id)
			|| typeof job.databaseId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(job.databaseId)
			|| job.databaseId !== d1DatabaseId || job.helperName !== `crate-delete-${job.id}`
			|| !['removing-worker', 'clearing-bucket', 'removing-database', 'removing-helper', 'complete'].includes(String(job.phase))
			|| (job.bucketCreatedAt !== null && (typeof job.bucketCreatedAt !== 'string' || !job.bucketCreatedAt))
			|| (job.workerCreatedAt !== null && (typeof job.workerCreatedAt !== 'string' || !job.workerCreatedAt))
			|| (job.helperUploadPending !== undefined && (typeof job.helperUploadPending !== 'string' || !/^crate-[a-f0-9-]{36}$/.test(job.helperUploadPending)))) return null;
		deletion = { id: job.id, databaseId: job.databaseId, helperName: job.helperName,
			phase: job.phase as NonNullable<CloudflareDeploymentMetadata['deletion']>['phase'],
			bucketCreatedAt: job.bucketCreatedAt, workerCreatedAt: job.workerCreatedAt,
			...(typeof job.helperUploadPending === 'string' ? { helperUploadPending: job.helperUploadPending } : {}) };
	}
	return {
		deploymentId,
		...(normalizeVaultName(value.vaultName) ? { vaultName: normalizeVaultName(value.vaultName) } : {}),
		accountId,
		accountName: normalizeNullableString(value.accountName),
		workerName,
		d1DatabaseName,
		d1DatabaseId,
		r2BucketName,
		workersSubdomain,
		lastDeployedVersion: normalizeNullableString(value.lastDeployedVersion),
		lastDeployedFingerprint,
		...(deletion ? { deletion } : {}),
		...(typeof value.lastKnownRevision === 'number' && Number.isSafeInteger(value.lastKnownRevision) && value.lastKnownRevision > 0
			? { lastKnownRevision: value.lastKnownRevision } : {}),
		...(isRecord(value.reset) && typeof value.reset.id === 'string' && /^[a-f0-9]{32}$/.test(value.reset.id)
			&& (value.reset.phase === 'clearing' || value.reset.phase === 'rebuilding')
			&& typeof value.reset.databaseId === 'string' && /^[a-f0-9-]{36}$/i.test(value.reset.databaseId)
			&& typeof value.reset.bucketCreatedAt === 'string' && value.reset.bucketCreatedAt.length > 0
			&& typeof value.reset.namespaceId === 'string' && /^[a-f0-9]{32}$/i.test(value.reset.namespaceId)
			? { reset: { id: value.reset.id, phase: value.reset.phase, databaseId: value.reset.databaseId,
				bucketCreatedAt: value.reset.bucketCreatedAt, namespaceId: value.reset.namespaceId,
				...(value.reset.deleteOnly === true ? { deleteOnly: true as const } : {}) } } : {}),
	};
}
