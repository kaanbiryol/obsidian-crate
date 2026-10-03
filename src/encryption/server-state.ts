import { isEncryptionId } from './encoding';
import { isEncryptionFolderPath, type RecoveryEnvelope, type VaultKeyBundle } from './key-bundle';

export const ENCRYPTION_CAPABILITY = 'e2ee-v1';
export const READING_ENCRYPTION_CAPABILITY = 'e2ee-reading-v1';
export const ENCRYPTION_FOLDER_MOVES_CAPABILITY = 'e2ee-folder-moves-v1';
export const ENCRYPTION_PROTOCOL = 2;

export interface EncryptionScope {
	purpose?: 'reading';
	accessId?: string;
	binding?: string;
	id: string;
	folderPath: string;
	keyId: string;
	notificationKeyId: string;
}

/** Public routing metadata and a recovery envelope. No unwrapped secrets. */
export interface EncryptionServerState {
	version: 1;
	vaultId: string;
	generation: number;
	mode: 'converting' | 'active' | 'resetting';
	keyId: string;
	scopes: EncryptionScope[];
	recovery: RecoveryEnvelope;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function exactFields(value: Record<string, unknown>, fields: string[]): void {
	if (Object.keys(value).some(field => !fields.includes(field))) throw new Error('Unexpected encryption configuration field');
}

export function validateEncryptionState(value: unknown): asserts value is EncryptionServerState {
	if (!record(value)) throw new Error('Invalid encryption configuration');
	exactFields(value, ['version', 'vaultId', 'generation', 'mode', 'keyId', 'scopes', 'recovery']);
	if (value.version !== 1 || !isEncryptionId(value.vaultId) || !isEncryptionId(value.keyId)
		|| !Number.isSafeInteger(value.generation) || (value.generation as number) < 1
		|| (value.mode !== 'converting' && value.mode !== 'active' && value.mode !== 'resetting')
		|| !Array.isArray(value.scopes) || value.scopes.length > 128) throw new Error('Unsupported encryption configuration');
	const ids = new Set([value.keyId, 'vault']);
	const folders = new Set<string>();
	for (const scope of value.scopes) {
		if (!record(scope)) throw new Error('Invalid encryption scope');
		exactFields(scope, ['id', 'folderPath', 'purpose', 'accessId', 'binding', 'keyId', 'notificationKeyId']);
		if (scope.accessId !== undefined && !isEncryptionId(scope.accessId)) throw new Error('Invalid folder access identity');
		if (scope.binding !== undefined && (typeof scope.binding !== 'string' || scope.binding.length > 8192 || scope.binding.split('.').length !== 5)) throw new Error('Invalid encrypted folder binding');
		if ((scope.purpose !== undefined && scope.purpose !== 'reading') || ![scope.id, scope.keyId, scope.notificationKeyId].every(isEncryptionId)
			|| !isEncryptionFolderPath(scope.folderPath)
			|| folders.has(scope.folderPath)) throw new Error('Invalid encryption scope');
		folders.add(scope.folderPath);
		const folderPath = scope.folderPath;
		if ([...folders].some(folder => folder !== folderPath && (folder.startsWith(folderPath + '/') || folderPath.startsWith(folder + '/')))) throw new Error('Encrypted reminders folders must not overlap');
		for (const id of [scope.id, scope.keyId, scope.notificationKeyId] as string[]) {
			if (ids.has(id)) throw new Error('Duplicate encryption scope or key');
			ids.add(id);
		}
	}
	if (!record(value.recovery)) throw new Error('Missing encrypted recovery bundle');
	exactFields(value.recovery, ['version', 'vaultId', 'envelope']);
	if (value.recovery.version !== 1 || value.recovery.vaultId !== value.vaultId || typeof value.recovery.envelope !== 'string'
		|| value.recovery.envelope.length > 256 * 1024 || value.recovery.envelope.split('.').length !== 5) throw new Error('Invalid encrypted recovery bundle');
}

export function createEncryptionState(bundle: VaultKeyBundle, recovery: RecoveryEnvelope): EncryptionServerState {
	const state: EncryptionServerState = { version: 1, vaultId: bundle.vaultId, generation: bundle.generation,
		mode: 'converting', keyId: bundle.vault.id, recovery,
		scopes: bundle.scopes.map(scope => ({ id: scope.id, folderPath: scope.folderPath, ...(scope.accessId ? { accessId: scope.accessId } : {}),
			...(scope.purpose ? { purpose: scope.purpose } : {}), keyId: scope.data.id, notificationKeyId: scope.notifications.id })) };
	validateEncryptionState(state);
	return state;
}

export function encryptionScopeForPath(state: EncryptionServerState, path: string): { id: string; keyId: string } {
	return state.scopes.filter(scope => path.startsWith(`${scope.folderPath}/`))
		.sort((left, right) => right.folderPath.length - left.folderPath.length)[0] ?? { id: 'vault', keyId: state.keyId };
}

/** A narrowly scoped upgrade for vaults encrypted before Reading support. Existing
 * keys stay unchanged; only a previously vault-scoped Reading folder is split off. */
export function isReadingScopeExtension(previous: EncryptionServerState, next: EncryptionServerState): boolean {
  if (previous.mode !== 'active' || next.mode !== 'converting' || next.vaultId !== previous.vaultId || next.keyId !== previous.keyId
    || next.generation !== previous.generation + 1 || next.scopes.length !== previous.scopes.length + 1) return false;
  if (previous.scopes.some(scope => !next.scopes.some(candidate => candidate.id === scope.id && candidate.folderPath === scope.folderPath
    && candidate.keyId === scope.keyId && candidate.notificationKeyId === scope.notificationKeyId && candidate.purpose === scope.purpose && candidate.accessId === scope.accessId))) return false;
  return next.scopes.filter(scope => !previous.scopes.some(old => old.id === scope.id)).every(scope => scope.purpose === 'reading');
}

/** Moving a scope never adds authority or changes any encryption key. */
export function isEncryptionScopeMove(previous: EncryptionServerState, next: EncryptionServerState): boolean {
	if (previous.mode !== 'active' || next.mode !== 'converting' || next.vaultId !== previous.vaultId || next.keyId !== previous.keyId
		|| next.generation !== previous.generation + 1 || next.scopes.length !== previous.scopes.length) return false;
	return previous.scopes.every(scope => next.scopes.some(candidate => candidate.id === scope.id && candidate.keyId === scope.keyId
		&& candidate.notificationKeyId === scope.notificationKeyId && candidate.purpose === scope.purpose
		&& (candidate.folderPath !== scope.folderPath || candidate.accessId === scope.accessId)))
		&& previous.scopes.some(scope => next.scopes.find(candidate => candidate.id === scope.id)!.folderPath !== scope.folderPath);
}
