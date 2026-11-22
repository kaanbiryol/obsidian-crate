import { parseDevelopmentBuild, type DevelopmentBuild } from './server-build';
import { isSha256Hex } from '../platform/validation';
import { DEFAULT_BATCH_LIMITS, MAX_FILE_SIZE_BYTES, parseBatchLimits, parseMaxFileBytes, type BatchLimits } from './sync-limits';
export const CRATE_SERVICE_ID = 'crate';

export interface CrateProtocolRange {
	readonly current: number;
	readonly oldestCompatible: number;
}

export interface CrateServerInfo {
	readonly service: typeof CRATE_SERVICE_ID;
	readonly serverVersion: string;
	readonly protocol: CrateProtocolRange;
	readonly capabilities: readonly string[];
	readonly reminderOperationDay: number;
	readonly serverRevision: number;
	readonly developmentBuild?: DevelopmentBuild;
	readonly pwaAssetVersion?: string;
	readonly deploymentFingerprint?: string;
	/** Absent on servers older than protocol 2 and on Cloudflare, which allow the defaults. */
	readonly limits?: { readonly maxFileBytes: number; readonly batch?: BatchLimits };
}

/**
 * Increment `current` for every protocol change. Raise `oldestCompatible` only
 * when support for an older protocol is intentionally removed.
 */
export const CRATE_PLUGIN_PROTOCOL: CrateProtocolRange = Object.freeze({
	current: 2,
	oldestCompatible: 1,
});

/** What a Cloudflare server advertises: it never raises its file limit, so it offers protocol 1
 * as before. It still accepts protocol 2 from current clients. */
export const HOSTED_SERVER_PROTOCOL: CrateProtocolRange = Object.freeze({ current: 1, oldestCompatible: 1 });

/** Protocol 2 clients honor the file limit a server advertises in `limits`. */
export const ADVERTISED_FILE_LIMIT_PROTOCOL = 2;

/** A server that allows larger files refuses older clients, which cannot read those files. */
export function serverProtocolRange(maxFileBytes: number): CrateProtocolRange {
	return maxFileBytes > MAX_FILE_SIZE_BYTES
		? Object.freeze({ current: CRATE_PLUGIN_PROTOCOL.current, oldestCompatible: ADVERTISED_FILE_LIMIT_PROTOCOL })
		: CRATE_PLUGIN_PROTOCOL;
}

/** The batch sizes the server accepts. */
export function serverBatchLimits(info: Pick<CrateServerInfo, 'limits'>): BatchLimits {
	return info.limits?.batch ?? DEFAULT_BATCH_LIMITS;
}

/** The largest file the server accepts. */
export function serverMaxFileBytes(info: Pick<CrateServerInfo, 'limits'>): number {
	return info.limits?.maxFileBytes ?? MAX_FILE_SIZE_BYTES;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
	return Array.isArray(value)
		&& value.every((item: unknown) => typeof item === 'string' && item.length > 0);
}

function isValidProtocolRange(value: unknown): value is CrateProtocolRange {
	if (!value || typeof value !== 'object') return false;
	const range = value as Partial<CrateProtocolRange>;
	return isPositiveInteger(range.current)
		&& isPositiveInteger(range.oldestCompatible)
		&& range.oldestCompatible <= range.current;
}

export function areProtocolRangesCompatible(
	left: CrateProtocolRange,
	right: CrateProtocolRange,
): boolean {
	return left.oldestCompatible <= right.current
		&& right.oldestCompatible <= left.current;
}

export function parseCrateServerInfo(value: unknown): CrateServerInfo | null {
	if (!value || typeof value !== 'object') return null;
	const info = value as Partial<CrateServerInfo>;
	if (
		info.service !== CRATE_SERVICE_ID
		|| typeof info.serverVersion !== 'string'
		|| info.serverVersion.trim().length === 0
		|| !isValidProtocolRange(info.protocol)
		|| !isNonEmptyStringArray(info.capabilities)
		|| !isPositiveInteger(info.serverRevision)
		|| !isPositiveInteger(info.reminderOperationDay)
	) {
		return null;
	}

	return {
		service: CRATE_SERVICE_ID,
		serverVersion: info.serverVersion,
		protocol: {
			current: info.protocol.current,
			oldestCompatible: info.protocol.oldestCompatible,
		},
		capabilities: [...info.capabilities],
		...(typeof info.pwaAssetVersion === 'string' && /^[a-zA-Z0-9._-]{1,128}$/.test(info.pwaAssetVersion) ? { pwaAssetVersion: info.pwaAssetVersion } : {}),
		...(parseDevelopmentBuild(info.developmentBuild) ? { developmentBuild: parseDevelopmentBuild(info.developmentBuild) } : {}),
		serverRevision: info.serverRevision,
		...(isSha256Hex(info.deploymentFingerprint) ? { deploymentFingerprint: info.deploymentFingerprint } : {}),
		reminderOperationDay: info.reminderOperationDay,
		limits: { maxFileBytes: parseMaxFileBytes(info.limits?.maxFileBytes), batch: parseBatchLimits(info.limits?.batch) },
	};
}

export function isCompatibleCrateServer(info: CrateServerInfo): boolean {
	return areProtocolRangesCompatible(CRATE_PLUGIN_PROTOCOL, info.protocol);
}

export const CRATE_PROTOCOL_HEADER = 'X-Crate-Protocol';
/** POST routes that only read, so they skip mutation logging and protocol checks. */
export const READ_ONLY_POST_PATHS: readonly string[] = ['/sync/metadata', '/sync/batch-download', '/encryption/metadata', '/links/title',
	'/reminders/encrypted-files/download', '/reading/encrypted-files/download'];
export function isCrateMutation(path: string, method = 'GET'): boolean {
	return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())
		&& !READ_ONLY_POST_PATHS.includes(path.split('?')[0] ?? path);
}
