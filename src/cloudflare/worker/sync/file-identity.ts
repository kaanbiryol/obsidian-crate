import { portablePathKey } from '../../../protocol/portable-path';
import type { SqlGuard } from '../db';

export const FILE_PATH_MATCH = 'portable_path = ? AND path = ?';
export function filePathArgs(path: string): [string, string] {
  return [portablePathKey(path), path];
}

/** Narrow by the primary key, then retain the selected folder's exact spelling. */
export const FILE_FOLDER_MATCH = "portable_path >= ? AND portable_path < ? AND path >= ? AND path < ?";
export function fileFolderArgs(folder: string): string[] {
  const key = portablePathKey(folder);
  return [`${key}/`, `${key}0`, `${folder}/`, `${folder}0`];
}

/** The file still has this exact revision. Evaluate inside the dependent write. */
export function fileRevisionGuard(path: string, storageKey: string): SqlGuard {
  return { sql: `EXISTS (SELECT 1 FROM files WHERE ${FILE_PATH_MATCH} AND storage_key = ?)`, args: [...filePathArgs(path), storageKey] };
}

/** Every listed file still has its exact revision. */
export function fileRevisionsGuard(files: ReadonlyArray<{ path: string; storageKey: string }>): SqlGuard {
  const guards = files.map(file => fileRevisionGuard(file.path, file.storageKey));
  return { sql: guards.map(guard => guard.sql).join(' AND '), args: guards.flatMap(guard => guard.args) };
}
