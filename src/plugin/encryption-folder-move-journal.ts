import { isEncryptionFolderPath, moveEncryptionScopes, sameVaultKeyBundle, validateVaultKeyBundle, type VaultKeyBundle } from '../encryption/key-bundle';
import type { SecretStorageService } from './secret-storage';
import { SECRET_KEYS } from './settings-types';
import { parseRenameDependencies } from '../sync/rename-dependencies';

interface FolderSetting { from: string; to: string }
export interface FolderMove {
  id: string; from: string; to: string; target?: VaultKeyBundle;
  /** Settings changes do not rename local files. Missing on older filesystem journals. */
  rename?: boolean;
  scopeChange?: boolean;
  priorRenames?: Record<string, string>;
  settings?: { reading: FolderSetting; reminders: FolderSetting };
}
interface FolderMoves { version: 1; moves: FolderMove[] }
export const movedPath = (path: string, from: string, to: string) => path === from || path.startsWith(from + '/') ? to + path.slice(from.length) : path;
const validPath = isEncryptionFolderPath;

/** Damaged or future journals are never treated as an empty queue. */
export function readFolderMoves(storage: SecretStorageService): FolderMoves {
  const raw = storage.get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES);
  if (!raw) return { version: 1, moves: [] };
  const value = JSON.parse(raw) as FolderMoves | null;
  if (!value || value.version !== 1 || !Array.isArray(value.moves) || !value.moves.length || value.moves.length > 128
    || new Set(value.moves.map(move => move?.id)).size !== value.moves.length
    || value.moves.some(move => !move || typeof move.id !== 'string' || !move.id || !validPath(move.from) || !validPath(move.to)
      || move.rename !== undefined && typeof move.rename !== 'boolean' || move.scopeChange !== undefined && typeof move.scopeChange !== 'boolean'
      || move.settings !== undefined && (!move.settings || [move.settings.reading, move.settings.reminders].some(setting => !setting || !validPath(setting.from) || !validPath(setting.to))))) {
    throw new Error('The saved encrypted folder move needs recovery. Keep this device’s Crate data.');
  }
  for (const move of value.moves) {
    if (move.target !== undefined) validateVaultKeyBundle(move.target);
    parseRenameDependencies(move.priorRenames);
  }
  return value;
}

export function writeFolderMoves(storage: SecretStorageService, value: FolderMoves): void {
  const raw = value.moves.length ? JSON.stringify(value) : '';
  storage.set(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES, raw);
  if ((storage.get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES) ?? '') !== raw) throw new Error('Could not save the encrypted folder move.');
}

/** A saved target may be the current bundle after a lost reply, or exactly its
 * proposed path change. Never replace keys using an unrelated checkpoint. */
export function folderMoveTarget(keys: VaultKeyBundle, move: FolderMove): VaultKeyBundle {
  if (move.scopeChange === false) return keys;
  const proposed = () => moveEncryptionScopes(keys, move.from, move.to, move.rename === false ? move.id : undefined);
  if (!move.target) return proposed();
  if (sameVaultKeyBundle(keys, move.target) || sameVaultKeyBundle(proposed(), move.target)) return move.target;
  throw new Error('The saved folder move does not match this device’s encryption keys. Use server folder settings to recover.');
}

export function folderMoveSettings(move: FolderMove, target: VaultKeyBundle, reading: string, reminders: string): NonNullable<FolderMove['settings']> {
  // Earlier journals did not save setting destinations. If conversion already
  // updated a setting, its target scope path identifies the completed save.
  const setting = (path: string, purpose?: 'reading'): FolderSetting => ({ from: path,
    to: target.scopes.some(scope => scope.folderPath === path && scope.purpose === purpose) ? path : movedPath(path, move.from, move.to) });
  return { reading: setting(reading, 'reading'), reminders: setting(reminders) };
}

export function applyFolderSetting(current: string, setting: FolderSetting): string {
  if (current !== setting.from && current !== setting.to) throw new Error('Folder settings changed. Use server folder settings to recover.');
  return setting.to;
}
