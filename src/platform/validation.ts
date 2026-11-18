export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether two JSON values hold the same data; undefined fields count as absent. */
export function sameJson(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value: unknown, index) => sameJson(value, right[index]));
	if (!isRecord(left) || !isRecord(right)) return false;
	const leftKeys = Object.keys(left).filter(key => left[key] !== undefined);
	const rightKeys = Object.keys(right).filter(key => right[key] !== undefined);
	return leftKeys.length === rightKeys.length && leftKeys.every(key => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
}

/** Canonical lowercase SHA-256 hex digest. */
export function isSha256Hex(value: unknown): value is string {
	return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function normalizeNullableString(value: unknown): string | null {
	if (typeof value !== 'string') {
		return null;
	}

	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

export function normalizeStringArray(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) {
		return [...fallback];
	}

	const normalized = new Set<string>();
	for (const item of value) {
		if (typeof item !== 'string') {
			continue;
		}

		const trimmed = item.trim();
		if (trimmed.length > 0) {
			normalized.add(trimmed);
		}
	}

	return [...normalized];
}

/** C0 control characters and DEL, which no stored name or folder may contain. */
export function containsControlCharacters(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
			return true;
		}
	}
	return false;
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A 24-hour HH:MM time, or null. */
export function normalizeTimeString(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const match = TIME_PATTERN.exec(value.trim());
	return match ? `${match[1]}:${match[2]}` : null;
}
