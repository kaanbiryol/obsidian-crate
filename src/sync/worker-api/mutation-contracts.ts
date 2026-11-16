import { isRecord } from '../../platform/validation';
import type { BatchDeleteResponse, BatchDownloadResponse, BatchUploadResponse, UploadResult } from '../../protocol/sync-types';

/**
 * Shapes of write responses, checked when they arrive and before any field is read.
 * These checks keep the original object, since encrypted downloads read fields the
 * types do not name. Callers still check that a response answers what they sent
 * (paths, hashes and the revision a success must carry). A failure `code` the client
 * does not know passes through and matches no refusal rule. Fields the client never
 * reads, such as a download's content type, may be absent.
 */
const invalid = (): never => { throw new Error('Invalid or unsupported sync write response. The change is preserved for retry.'); };

const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isStatus = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599;

function isFailureFields(value: Record<string, unknown>): boolean {
	return optional(value.error, isString) && optional(value.code, isString) && optional(value.status, isStatus)
		&& optional(value.currentHash, hash => hash === null || isString(hash));
}

function isUploadResult(value: unknown): value is UploadResult {
	return isRecord(value) && typeof value.success === 'boolean' && isString(value.path)
		&& optional(value.hash, isString) && optional(value.revision, isString) && isFailureFields(value);
}

export function parseUploadResult(value: unknown): UploadResult {
	return isUploadResult(value) ? value : invalid();
}

export function parseBatchUpload(value: unknown): BatchUploadResponse {
	if (!isRecord(value) || typeof value.success !== 'boolean' || !Array.isArray(value.results) || !value.results.every(isUploadResult)) return invalid();
	return value as unknown as BatchUploadResponse;
}

export function parseBatchDownload(value: unknown): BatchDownloadResponse {
	if (!isRecord(value) || !Array.isArray(value.files)) return invalid();
	for (const file of value.files) {
		if (!isRecord(file) || !isString(file.path) || !isString(file.content) || !isString(file.hash) || !isCount(file.size)
			|| !optional(file.contentType, isString) || !optional(file.revision, isString) || !optional(file.error, isString)) return invalid();
	}
	return value as unknown as BatchDownloadResponse;
}

export function parseBatchDelete(value: unknown): BatchDeleteResponse {
	if (!isRecord(value) || typeof value.success !== 'boolean' || !Array.isArray(value.deleted) || !value.deleted.every(isString)) return invalid();
	if (!optional(value.results, results => Array.isArray(results) && results.every(result => isRecord(result) && isString(result.path)
		&& optional(result.revision, isString) && optional(result.consumedRevision, isString) && optional(result.deleteRequestId, isString)))) return invalid();
	if (!optional(value.errors, errors => Array.isArray(errors) && errors.every(error => isRecord(error) && isString(error.path) && isString(error.error)
		&& isFailureFields(error)))) return invalid();
	return value as unknown as BatchDeleteResponse;
}
