import { normalizeSharedSettingsValue, type SharedSettings } from '../../protocol/shared-settings';
import type { SyncSettings } from '../settings';
import type { SyncApiClient } from '../worker-api/client';
import { HttpError } from '../worker-api/http';

type SharedSettingsTarget = Pick<
	SyncSettings,
	'ignorePatterns' | 'syncInterval' | 'pushEnabled'
>;

const SHARED_SETTING_KEYS = ['ignorePatterns', 'syncInterval', 'pushEnabled'] as const;

/** Settings replicated to other devices. */
export function buildSharedSettings(settings: SharedSettingsTarget): SharedSettings {
	return {
		ignorePatterns: settings.ignorePatterns,
		syncInterval: settings.syncInterval,
		pushEnabled: settings.pushEnabled,
	};
}

function sameValue(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

export function sameSharedSettings(a: SharedSettingsTarget, b: SharedSettingsTarget): boolean {
	return sameValue(buildSharedSettings(a), buildSharedSettings(b));
}

/** Three-way merge: settings changed locally since `base` replace the server's, which keeps
 * the rest. Null when both sides changed one setting to different values. */
export function rebaseSharedSettings(base: SharedSettings, local: SharedSettings, remote: SharedSettings): SharedSettings | null {
	const merged = buildSharedSettings(remote);
	for (const key of SHARED_SETTING_KEYS) {
		if (sameValue(local[key], base[key]) || sameValue(local[key], remote[key])) continue;
		if (!sameValue(remote[key], base[key])) return null;
		Object.assign(merged, { [key]: local[key] });
	}
	return merged;
}

export type SharedSettingsSave =
	| { status: 'saved'; settings: SharedSettings }
	| { status: 'conflict'; settings: SharedSettings | null };

/** Writes the settings this device changed since `base` onto the server's settings as this
 * client last read or wrote them, reading first when it has not. The write is conditional on
 * that version, so it never replaces another device's edit: a newer version, or a setting
 * both devices changed, returns the server's current settings as a conflict instead. */
export async function saveSharedSettingsChanges(
	api: Pick<SyncApiClient, 'getKnownSharedSettings' | 'getSharedSettings' | 'putSharedSettings'>,
	base: SharedSettings,
	local: SharedSettings,
	/** Applies this device's local normalization to the server's settings before comparing. */
	normalize: (settings: SharedSettings) => SharedSettings = settings => settings,
): Promise<SharedSettingsSave> {
	const known = readableSharedSettings((await api.getKnownSharedSettings()).settings);
	const remote = known && normalize(known);
	const next = remote ? rebaseSharedSettings(base, local, remote) : local;
	if (!next) return { status: 'conflict', settings: remote };
	if (remote && sameSharedSettings(next, remote)) return { status: 'saved', settings: remote };
	try {
		await api.putSharedSettings(next);
		return { status: 'saved', settings: next };
	} catch (error) {
		if (!(error instanceof HttpError) || error.status !== 409) throw error;
		const current = readableSharedSettings((await api.getSharedSettings()).settings);
		return { status: 'conflict', settings: current && normalize(current) };
	}
}

/** An encrypted vault read without its keys returns an envelope, which must not be replaced. */
function readableSharedSettings(settings: SharedSettings | null): SharedSettings | null {
	if (settings === null) return null;
	const readable = normalizeSharedSettingsValue(settings);
	if (!readable) throw new Error('Could not read the server\'s shared settings');
	return readable;
}
