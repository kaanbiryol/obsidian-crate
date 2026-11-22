import { sha256Hex } from '@/platform/sha256';
import type { Plugin } from "obsidian";
import type { SecretStorageService } from "../secret-storage";
import { requireNormalizedWorkerUrl } from "../connection/worker-url";
import type { VaultKeyBundle } from '../../encryption/key-bundle';
import { SECRET_KEYS } from '../../platform/secret-keys';
import type { SyncSettings } from '../settings';
import { syncStoragePaths, retiredUploadPath, previousCheckpointCopy } from '../manifest/storage-paths';
import { isUnfinishedUploadRecord } from '../durability/upload-journal';

interface ApplyInfrastructureConfigInput {
	workerUrl: string;
	authToken: string;
	encryption?: { bundle: VaultKeyBundle; recovery: string };
	/** The user confirmed replacing this vault with the new server's contents. */
	replaceVault?: boolean;
}

/** Caller must stop the old engine and await its checkpoint I/O first. */
export async function deleteManifestFile(plugin: Plugin, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	const adapter = plugin.app.vault.adapter;
	const paths = syncStoragePaths(plugin.manifest.dir!);
	const checkpoints: Array<{ path: string; content: string | ArrayBuffer; backupPath?: string }> = [];
	for (const path of [paths.manifest, paths.manifestTmp, paths.manifestLog]) {
		if (await adapter.exists(path)) {
			signal?.throwIfAborted();
			checkpoints.push({ path, content: await adapter.read(path) });
		}
		signal?.throwIfAborted();
	}
	const journalDirectory = paths.uploadJournal;
	if (await adapter.exists(journalDirectory)) {
		const listing = await adapter.list(journalDirectory);
		for (const path of listing.files) {
			signal?.throwIfAborted();
			// An interrupted record write was never dispatched; the next journal load removes it.
			if (isUnfinishedUploadRecord(path)) continue;
			// A chunked upload's bytes are binary; records are text.
			checkpoints.push({ path, content: path.endsWith('.bin') ? await adapter.readBinary(path) : await adapter.read(path),
				backupPath: retiredUploadPath(plugin.manifest.dir!, path.split('/').at(-1)!) });
		}
	}
	// Preserve both generations for investigation/recovery before invalidating
	// either. These copies are never candidates for normal checkpoint recovery.
	const recoveryId = crypto.randomUUID();
	for (const checkpoint of checkpoints) {
		signal?.throwIfAborted();
		const backup = previousCheckpointCopy(checkpoint.backupPath ?? checkpoint.path, recoveryId);
		const { content } = checkpoint;
		if (typeof content === 'string') await adapter.write(backup, content); else await adapter.writeBinary(backup, content);
		signal?.throwIfAborted();
		const copied = typeof content === 'string' ? await adapter.read(backup) === content
			: await sha256Hex(await adapter.readBinary(backup)) === await sha256Hex(content);
		if (!copied) throw new Error('Could not verify the previous sync checkpoint backup');
	}
	for (const checkpoint of checkpoints) {
		signal?.throwIfAborted();
		await adapter.remove(checkpoint.path);
		signal?.throwIfAborted();
		if (await adapter.exists(checkpoint.path)) throw new Error('Could not invalidate the previous sync checkpoint');
	}
}

export function applyInfrastructureConfigState(
	settings: SyncSettings,
	secretStorage: SecretStorageService,
	config: ApplyInfrastructureConfigInput,
): void {
	const authToken = config.authToken.trim();
	if (!authToken) {
		throw new Error("Auth token is required");
	}

	settings.workerUrl = requireNormalizedWorkerUrl(config.workerUrl);
	secretStorage.set(SECRET_KEYS.AUTH_TOKEN, authToken);
}

export function clearSyncConfigurationState(
	settings: SyncSettings,
	secretStorage: SecretStorageService,
): void {
	for (const key of [SECRET_KEYS.ENCRYPTION_KEYS, SECRET_KEYS.ENCRYPTION_RECOVERY, SECRET_KEYS.AUTH_TOKEN]) {
		secretStorage.delete(key);
		if (secretStorage.get(key)) throw new Error('Could not remove this device’s previous sync credentials');
	}
	settings.workerUrl = "";
}

export type { ApplyInfrastructureConfigInput };
