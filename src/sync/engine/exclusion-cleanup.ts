import type { FileManifest } from '../../protocol/sync-types';
import { createAbortError } from '../abort';
import { deleteFilesInBatches } from '../transfer/delete-batches';
import type { EngineFileOperations } from './file-operations';
import type { LocalManifest } from '../manifest/manifest';

interface ExclusionCleanupContext {
	getManifest(): Promise<FileManifest>;
	getIgnorePatterns(): readonly string[];
	shouldIgnore(path: string): boolean;
	assertActive(): void;
	runExclusive<T>(operation: () => Promise<T>): Promise<T>;
	retryWithBackoff<T>(operation: () => Promise<T>): Promise<T>;
	batchDelete: EngineFileOperations['batchDelete'];
	manifest: Pick<LocalManifest, 'removeEntry' | 'save'>;
}

/** Keep confirmation bound to the reviewed files and their immutable revisions. */
export async function createExclusionCleanupReview(context: ExclusionCleanupContext) {
	const exclusions = JSON.stringify(context.getIgnorePatterns());
	const verify = () => {
		context.assertActive();
		if (exclusions !== JSON.stringify(context.getIgnorePatterns())) {
			throw createAbortError('Sync exclusions changed. Review the excluded server files again.');
		}
	};
	verify();
	const remote = await context.getManifest();
	verify();
	const candidates = Object.keys(remote.files).filter(path => context.shouldIgnore(path)).sort().map(path => ({
		path,
		expectedHash: remote.files[path]!.hash,
		expectedRevision: remote.files[path]!.revision,
	}));
	return {
		paths: candidates.map(file => file.path),
		execute: () => context.runExclusive(async () => {
			verify();
			const result = await deleteFilesInBatches({
				batchDelete: (paths, expectedHashes, expectedRevisions) => context.retryWithBackoff(() => {
					verify();
					return context.batchDelete(paths, expectedHashes, expectedRevisions);
				}),
			}, candidates);
			// A later batch may be cancelled after earlier deletes committed. Save
			// every acknowledgement before reporting cancellation or stale settings.
			for (const path of result.deleted) context.manifest.removeEntry(path);
			await context.manifest.save();
			verify();
			if (result.outcome === 'cancelled') throw createAbortError('Remote cleanup cancelled');
			return { deleted: result.deleted, errors: result.errors.map(error => `${error.path}: ${error.error}`) };
		}),
	};
}
