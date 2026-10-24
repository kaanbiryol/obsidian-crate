import { isRecord, isSha256Hex } from '../../platform/validation';
import { createPathRecord } from '../../protocol/path-record';
import { isSyncPath } from '../../protocol/sync-validation';

/** Local setup bytes that may be replaced during an empty vault's first pull. */
export interface InitialConfigPull {
	configDir: string;
	files: Record<string, string>;
}

export function parseInitialConfigPull(value: unknown): InitialConfigPull | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value) || !isSyncPath(value.configDir) || !isRecord(value.files)) {
		throw new Error('Invalid initial settings pull checkpoint');
	}
	const files = createPathRecord<string>();
	for (const [path, hash] of Object.entries(value.files)) {
		if (!isSyncPath(path) || !path.startsWith(`${value.configDir}/`) || !isSha256Hex(hash)) {
			throw new Error('Invalid initial settings pull checkpoint');
		}
		files[path] = hash;
	}
	return { configDir: value.configDir, files };
}
