import type { Vault } from 'obsidian';
import type { MutationFailure } from '../../protocol/sync-types';
import { createAbortError } from '../abort';
import { deleteFilesInBatches, type ConditionalDeleteApi, type ConditionalDeleteCandidate } from './delete-batches';
import { recordSyncError } from '../issues';
import { assertLocalFileAbsent } from '../local/local-absence';
import { isVersionConflict } from '../failures';
import { pendingChangeKey } from '../pending/pending-change';
import type { SyncResult, SyncWork } from '../types';

interface DeleteContext {
	files: ConditionalDeleteApi;
	vault: Vault;
	localManifest: { removeEntry(path: string): void; save(): Promise<void> };
	reportWork?(work: SyncWork): void;
}

export interface DeleteOptions {
	onProcessed?(count: number): void;
	onVersionConflicts?(paths: string[], result: SyncResult): Promise<void>;
}

export type DeleteRemoteFiles = (files: ConditionalDeleteCandidate[], result: SyncResult, options?: DeleteOptions) => Promise<MutationFailure[]>;

/** A conditional delete replaces a known remote version. A path without one is
 * recorded as an error and left out. */
export function createDeleteCandidates(
	versions: ReadonlyArray<{ path: string; hash?: string; revision?: string }>,
	result: SyncResult,
): ConditionalDeleteCandidate[] {
	return versions.flatMap(({ path, hash, revision }) => {
		if (!hash) { recordSyncError(result, 'Missing remote version for delete', path); return []; }
		return [{ path, expectedHash: hash, expectedRevision: revision }];
	});
}

/** Shared remote deletion policy for every sync mode. The API owns rename guards. */
export async function deleteRemoteFiles(context: DeleteContext, files: ConditionalDeleteCandidate[], result: SyncResult, options: DeleteOptions = {}): Promise<MutationFailure[]> {
	if (!files.length) return [];
	let processed = 0;
	context.reportWork?.({ phase: 'deleting', current: processed, total: files.length });
	const response = result.errors.length
		? { outcome: 'failed' as const, deleted: [], errors: files.map((file): MutationFailure => ({ path: file.path, error: 'Remote deletion deferred until uploads and reconciliation finish successfully' })) }
		: await deleteFilesInBatches(context.files, files, path => assertLocalFileAbsent(context.vault, path), count => {
			processed += count;
			context.reportWork?.({ phase: 'deleting', current: processed, total: files.length });
			options.onProcessed?.(count);
		});
	for (const path of response.deleted) {
		context.localManifest.removeEntry(path);
		result.deleted++;
		result.deletedPaths.push(path);
	}
	const conflicts: MutationFailure[] = [];
	for (const failure of response.errors) {
		if (options.onVersionConflicts && isVersionConflict(failure.status, failure.code)) conflicts.push(failure);
		else recordSyncError(result, failure.error, failure.path);
	}
	if (response.outcome === 'cancelled') {
		if (response.deleted.length) await context.localManifest.save();
		throw createAbortError('Remote deletion cancelled');
	}
	if (conflicts.length) {
		// A retry can itself be cancelled; first make accepted sibling deletes durable.
		if (response.deleted.length) await context.localManifest.save();
		await options.onVersionConflicts?.(conflicts.map(failure => pendingChangeKey('delete', failure.path)), result);
	}
	return response.errors;
}
