import { corsResponse } from './cors';

const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/i;

function containsControlCharacters(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
			return true;
		}
	}
	return false;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function parseJsonObject(
	request: Request,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> {
	try {
		const parsed: unknown = await request.json();
		if (!isRecord(parsed)) {
			return { ok: false, response: corsResponse({ error: 'JSON object body required' }, 400) };
		}
		return { ok: true, value: parsed };
	} catch {
		return { ok: false, response: corsResponse({ error: 'Invalid JSON body' }, 400) };
	}
}

export function sanitizePath(path: string): string | null {
	if (typeof path !== 'string') return null;
	if (!path || path !== path.trim() || path.startsWith('/') || path.endsWith('/') || path.includes('\\')) {
		return null;
	}
	if (containsControlCharacters(path)) {
		return null;
	}

	const segments = path.split('/');
	if (segments.length === 0 || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
		return null;
	}

	return segments.join('/');
}

export function parseOptionalString(value: unknown, maxLength = 4096): string | null {
	if (value === undefined || value === null) {
		return null;
	}
	if (typeof value !== 'string') {
		return null;
	}

	const trimmed = value.trim();
	if (!trimmed || trimmed.length > maxLength || containsControlCharacters(trimmed)) {
		return null;
	}
	return trimmed;
}

export function parseStringArray(value: unknown, maxItems = 200, maxItemLength = 512): string[] | null {
	if (!Array.isArray(value) || value.length > maxItems) {
		return null;
	}

	const result: string[] = [];
	for (const item of value) {
		const parsed = parseOptionalString(item, maxItemLength);
		if (!parsed) {
			return null;
		}
		result.push(parsed);
	}
	return result;
}

export function parseNonNegativeInteger(value: unknown): number | null {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
		return null;
	}
	return value;
}

export function isSha256Hex(value: string): boolean {
	return SHA256_HEX_REGEX.test(value);
}

export const FILES_PREFIX = 'files/';
