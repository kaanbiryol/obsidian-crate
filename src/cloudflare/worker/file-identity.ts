import { portablePathKey } from '../../protocol/portable-path';

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
