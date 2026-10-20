import { isRecord } from '../platform/validation';

/** The `/reading/policy` record; `enabled` is the stored 0 or 1 flag. */
export interface ReadingPolicy { enabled: number; folder_path: string; generation: string; revision: string }

/** A `/reading/policy` write; `revision` names the replaced policy, or null for the first one. */
export interface ReadingPolicyUpdate { enabled: boolean; folderPath: string; revision: string | null }

export function parseReadingPolicy(value: unknown): ReadingPolicy | null {
	if (
		!isRecord(value)
		|| typeof value.enabled !== 'number'
		|| typeof value.folder_path !== 'string'
		|| typeof value.generation !== 'string'
		|| typeof value.revision !== 'string'
	) {
		return null;
	}
	return { enabled: value.enabled, folder_path: value.folder_path, generation: value.generation, revision: value.revision };
}
