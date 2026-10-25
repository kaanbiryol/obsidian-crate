import { isRecord } from '../platform/validation';

/** The `/reading/policy` record; `enabled` is the stored 0 or 1 flag. In an encrypted
 * vault `folder_path` is the folder's tag and `folder_label` seals its name. */
export interface ReadingPolicy { enabled: number; folder_path: string; generation: string; revision: string; folder_label?: string }

/** A `/reading/policy` write; `revision` names the replaced policy, or null for the first one. */
export interface ReadingPolicyUpdate { enabled: boolean; folderPath: string; revision: string | null; folderLabel?: string }

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
	if (value.folder_label !== undefined && typeof value.folder_label !== 'string') return null;
	return { enabled: value.enabled, folder_path: value.folder_path, generation: value.generation, revision: value.revision,
		...(value.folder_label === undefined ? {} : { folder_label: value.folder_label }) };
}
