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
}

/**
 * Increment `current` for every protocol change. Raise `oldestCompatible` only
 * when support for an older protocol is intentionally removed.
 */
export const CRATE_PLUGIN_PROTOCOL: CrateProtocolRange = Object.freeze({
	current: 4,
	oldestCompatible: 4,
});

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
	};
}

export function isCompatibleCrateServer(info: CrateServerInfo): boolean {
	return areProtocolRangesCompatible(CRATE_PLUGIN_PROTOCOL, info.protocol);
}

export const CRATE_PROTOCOL_HEADER = 'X-Crate-Protocol';
export function isCrateMutation(path: string, method = 'GET'): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())
    && !['/sync/metadata', '/sync/batch-download'].includes(path.split('?')[0] ?? path);
}
