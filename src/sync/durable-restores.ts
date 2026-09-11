import type { CrateServerInfo } from '../protocol';
import { createReminderOperationId } from '../protocol/reminder-operation';
import type { FileMetadataResponse, RemoteFileVersion, RestoreFileRequest, UploadResult } from '../protocol/sync-types';
import { getPathEntry } from '../protocol/path-record';
import type { LocalManifest } from './manifest';
import { HttpError } from './worker-api/http';

interface RestoreTransport {
	getServerInfo(): Promise<CrateServerInfo>;
	getFileMetadata(paths: string[]): Promise<FileMetadataResponse>;
	restoreFileVersion(request: RestoreFileRequest): Promise<UploadResult>;
}

/** A dialog retry or restart resumes its original intent until local sync finishes. */
export class DurableRestores {
	private chain: Promise<unknown> = Promise.resolve();
	constructor(private readonly manifest: LocalManifest, private readonly transport: RestoreTransport) {}

	restore(version: RemoteFileVersion): Promise<void> {
		const work = this.chain.catch(() => {}).then(() => this.resume(version));
		this.chain = work;
		return work;
	}

	private async resume(version: RemoteFileVersion): Promise<void> {
		let intent = this.manifest.getRestoreIntents().find(item => item.request.storageKey === version.storage_key);
		if (intent?.phase === 'committed') return;
		const info = await this.transport.getServerInfo();
		if (!info.capabilities.includes('restore-operation-receipts') || info.reminderOperationDay === undefined) {
			throw new Error('Update the Crate server before restoring files. This server cannot safely confirm restore retries.');
		}
		if (!intent) {
			const current = getPathEntry((await this.transport.getFileMetadata([version.path])).files, version.path);
			if (current && !current.revision) throw new Error('The server did not return the current file revision. Update it before restoring.');
			intent = { version, phase: 'pending', request: { operationId: createReminderOperationId(info.reminderOperationDay),
				path: version.path, storageKey: version.storage_key, expectedHash: current?.hash ?? null, expectedRevision: current?.revision ?? null } };
			this.manifest.setRestoreIntent(intent);
		}
		// Also retry failed checkpoint writes before dispatching an existing intent.
		await this.manifest.save();
		try {
			const result = await this.transport.restoreFileVersion(intent.request);
			if (!result.success || result.path !== intent.request.path || result.hash !== intent.version.hash || !result.revision) {
				throw new Error('Invalid restore receipt. The original restore is preserved; retry after checking the server.');
			}
		} catch (error) {
			if (error instanceof HttpError && ['version_conflict', 'namespace_conflict'].includes(error.code ?? '')) {
				this.manifest.removeRestoreIntent(version.storage_key);
				await this.manifest.save();
			}
			throw error;
		}
		this.manifest.setRestoreIntent({ ...intent, phase: 'committed' });
		await this.manifest.save();
	}

	pending(): RemoteFileVersion[] { return this.manifest.getRestoreIntents().map(item => item.version); }

	async finish(storageKey: string): Promise<void> {
		await this.chain.catch(() => {});
		if (!this.manifest.getRestoreIntents().some(item => item.request.storageKey === storageKey && item.phase === 'committed')) return;
		this.manifest.removeRestoreIntent(storageKey);
		await this.manifest.save();
	}
}
