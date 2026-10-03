import { decodeBase64Url, encodeBase64Url, isEncryptionId } from './encoding';
import { decryptJson, encryptJson, generateEncryptionSecret, importEncryptionSecret, type EncryptionSecret } from './envelope';

export interface ScopeKeys {
	purpose?: 'reading';
	/** Changes only when selecting a different folder, never for a filesystem move. */
	accessId?: string;
	id: string;
	folderPath: string;
	data: EncryptionSecret;
	notifications: EncryptionSecret;
}

export interface VaultKeyBundle {
	version: 1;
	vaultId: string;
	generation: number;
	vault: EncryptionSecret;
	scopes: ScopeKeys[];
}

export interface ReminderKeyGrant {
	version: 1;
	vaultId: string;
	generation: number;
	scope: ScopeKeys;
}

export interface RecoveryEnvelope {
	version: 1;
	vaultId: string;
	envelope: string;
}

export function createVaultKeyBundle(): VaultKeyBundle {
	return { version: 1, vaultId: crypto.randomUUID(), generation: 1, vault: generateEncryptionSecret(), scopes: [] };
}

export function addReminderScope(bundle: VaultKeyBundle, folderPath: string, purpose?: 'reading'): VaultKeyBundle {
	validateVaultKeyBundle(bundle);
	if (!isEncryptionFolderPath(folderPath)) throw new Error('Invalid reminders folder');
	const existing = bundle.scopes.find(scope => scope.folderPath === folderPath);
	if (existing) { if (existing.purpose !== purpose) throw new Error('Reading and reminders require separate encrypted folders'); return bundle; }
	if (bundle.scopes.some(scope => scope.folderPath.startsWith(folderPath + '/') || folderPath.startsWith(scope.folderPath + '/'))) throw new Error('Encrypted reminders folders must not overlap. Revoke overlapping folder enrollments before enabling encryption.');
	if (bundle.scopes.length >= 128) throw new Error('Too many encryption scopes');
	return { ...bundle, generation: bundle.generation + 1, scopes: [...bundle.scopes, {
		id: crypto.randomUUID(), folderPath, ...(purpose ? { purpose } : {}), data: generateEncryptionSecret(), notifications: generateEncryptionSecret(),
	}] };
}

/** Retain key identities when an enrolled folder or one of its parents moves. */
export function moveEncryptionScopes(bundle: VaultKeyBundle, from: string, to: string, accessId?: string): VaultKeyBundle {
	validateVaultKeyBundle(bundle);
	if (!isEncryptionFolderPath(from) || !isEncryptionFolderPath(to)) throw new Error('Choose valid folder paths');
	const scopes = bundle.scopes.map(scope => scope.folderPath === from || scope.folderPath.startsWith(from + '/')
		? { ...scope, folderPath: to + scope.folderPath.slice(from.length), ...(accessId ? { accessId } : {}) } : scope);
	if (scopes.every((scope, index) => scope.folderPath === bundle.scopes[index]!.folderPath)) return bundle;
	const next = { ...bundle, generation: bundle.generation + 1, scopes };
	validateVaultKeyBundle(next);
	return next;
}

/** Copy only the folder keys needed by a browser feature. */
export function createReminderKeyGrant(bundle: VaultKeyBundle, folderPath: string): ReminderKeyGrant {
	validateVaultKeyBundle(bundle);
	const scope = bundle.scopes.find(candidate => candidate.folderPath === folderPath);
	if (!scope) throw new Error('No encryption keys for this reminders folder');
	return { version: 1, vaultId: bundle.vaultId, generation: bundle.generation,
		scope: { id: scope.id, folderPath: scope.folderPath, ...(scope.accessId ? { accessId: scope.accessId } : {}), ...(scope.purpose ? { purpose: scope.purpose } : {}), data: { ...scope.data }, notifications: { ...scope.notifications } } };
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isEncryptionFolderPath(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 1024
		&& !value.includes('\\') && !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
		&& value.split('/').every(part => part.trim().length > 0 && part !== '.' && part !== '..');
}

function validateSecret(value: unknown): asserts value is EncryptionSecret {
	if (!record(value) || !isEncryptionId(value.id) || typeof value.secret !== 'string'
		|| Object.keys(value).some(key => !['id', 'secret'].includes(key))
		|| decodeBase64Url(value.secret, 32).length !== 32) throw new Error('Invalid encryption key bundle');
}

function validateScope(value: unknown): asserts value is ScopeKeys {
	if (!record(value) || !isEncryptionId(value.id) || !isEncryptionFolderPath(value.folderPath)) throw new Error('Invalid encryption scope');
	if (Object.keys(value).some(key => !['id', 'folderPath', 'purpose', 'accessId', 'data', 'notifications'].includes(key))) throw new Error('Unexpected encryption scope field');
	if (value.accessId !== undefined && !isEncryptionId(value.accessId)) throw new Error('Invalid folder access identity');
	if (value.purpose !== undefined && value.purpose !== 'reading') throw new Error('Invalid encryption scope purpose');
	validateSecret(value.data);
	validateSecret(value.notifications);
	if (value.data.id === value.notifications.id || value.data.secret === value.notifications.secret) throw new Error('Encryption scopes must use separate notification keys');
}

function validateBundleHeader(value: unknown): asserts value is Record<string, unknown> & { version: 1; vaultId: string; generation: number } {
	if (!record(value) || value.version !== 1 || !isEncryptionId(value.vaultId)
		|| typeof value.generation !== 'number' || !Number.isSafeInteger(value.generation) || value.generation < 1) {
		throw new Error('Unsupported or damaged encryption key bundle');
	}
}

export function validateReminderKeyGrant(value: unknown): asserts value is ReminderKeyGrant {
	validateBundleHeader(value);
	if (Object.keys(value).some(key => !['version', 'vaultId', 'generation', 'scope'].includes(key))) throw new Error('Unexpected key material in reminders grant');
	validateScope(value.scope);
}

export function validateVaultKeyBundle(value: unknown): asserts value is VaultKeyBundle {
	validateBundleHeader(value);
	if (Object.keys(value).some(key => !['version', 'vaultId', 'generation', 'vault', 'scopes'].includes(key))) throw new Error('Unexpected encryption key bundle field');
	validateSecret(value.vault);
	if (!Array.isArray(value.scopes) || value.scopes.length > 128) throw new Error('Invalid encryption scopes');
	const ids = new Set([value.vault.id]);
	const secrets = new Set([value.vault.secret]);
	const folders = new Set<string>();
	for (const scope of value.scopes) {
		validateScope(scope);
		if (ids.has(scope.id) || folders.has(scope.folderPath)) throw new Error('Duplicate encryption scope');
		if ([...folders].some(folder => folder.startsWith(scope.folderPath + '/') || scope.folderPath.startsWith(folder + '/'))) throw new Error('Encrypted reminders folders must not overlap');
		ids.add(scope.id);
		folders.add(scope.folderPath);
		for (const key of [scope.data, scope.notifications]) {
			if (ids.has(key.id) || secrets.has(key.secret)) throw new Error('Duplicate encryption key');
			ids.add(key.id);
			secrets.add(key.secret);
		}
	}
}

/** Compare validated bundles by identity and secret, independently of JSON order. */
export function sameVaultKeyBundle(left: VaultKeyBundle, right: VaultKeyBundle): boolean {
	const sameKey = (a: EncryptionSecret, b: EncryptionSecret) => a.id === b.id && a.secret === b.secret;
	return left.vaultId === right.vaultId && left.generation === right.generation && sameKey(left.vault, right.vault)
		&& left.scopes.length === right.scopes.length && left.scopes.every(scope => {
			const other = right.scopes.find(item => item.id === scope.id);
			return !!other && other.folderPath === scope.folderPath && other.purpose === scope.purpose && other.accessId === scope.accessId
				&& sameKey(other.data, scope.data) && sameKey(other.notifications, scope.notifications);
		});
}

const RECOVERY_PREFIX = 'crate-recovery-v1.';
async function recoveryChecksum(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	return encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)).slice(0, 6));
}

/** A random 256-bit recovery key, not a password or a server authentication token. */
export async function generateRecoveryCode(): Promise<string> {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	try { return `${RECOVERY_PREFIX}${encodeBase64Url(bytes)}.${await recoveryChecksum(bytes)}`; }
	finally { bytes.fill(0); }
}

async function recoveryKey(code: string) {
	const parts = code.trim().split('.');
	if (parts.length !== 3 || `${parts[0]}.` !== RECOVERY_PREFIX) throw new Error('Invalid recovery key');
	const bytes = decodeBase64Url(parts[1]!, 32);
	try {
		if (bytes.length !== 32 || parts[2] !== await recoveryChecksum(bytes)) throw new Error('Invalid recovery key');
		return await importEncryptionSecret({ id: 'recovery', secret: encodeBase64Url(bytes) });
	} finally { bytes.fill(0); }
}

const recoveryContext = (vaultId: string) => ({ vaultId, scopeId: 'recovery', objectId: 'key-bundle', purpose: 'key-bundle' as const });

export async function sealRecoveryBundle(bundle: VaultKeyBundle, code: string): Promise<RecoveryEnvelope> {
	validateVaultKeyBundle(bundle);
	return { version: 1, vaultId: bundle.vaultId,
		envelope: await encryptJson(bundle, await recoveryKey(code), recoveryContext(bundle.vaultId)) };
}

export async function openRecoveryBundle(value: unknown, code: string): Promise<VaultKeyBundle> {
	if (!record(value) || value.version !== 1 || !isEncryptionId(value.vaultId) || typeof value.envelope !== 'string'
		|| value.envelope.length > 256 * 1024) throw new Error('Unsupported or damaged recovery bundle');
	const bundle = await decryptJson(value.envelope, await recoveryKey(code), recoveryContext(value.vaultId));
	validateVaultKeyBundle(bundle);
	if (bundle.vaultId !== value.vaultId) throw new Error('Recovery bundle belongs to another vault');
	return bundle;
}
