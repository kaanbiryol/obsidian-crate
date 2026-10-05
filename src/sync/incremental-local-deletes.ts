import { recordSyncError } from './issues';
import { errorMessage } from '../plugin/logger';
import type { MutationFailure } from '../protocol/sync-types';
import type { IncrementalSyncPlannerContext } from './planner-types';
import type { SyncResult } from './types';
import { deleteFilesInBatches } from './delete-batches';
import { assertLocalFileAbsent } from './local-absence';

/** Apply local deletions only after earlier transfer and reconciliation phases succeed. */
export async function applyIncrementalLocalDeletes(
  context: Pick<IncrementalSyncPlannerContext, 'api' | 'vault' | 'localManifest' | 'reconcileVersionConflicts'>,
  localOnlyDeletes: readonly string[],
  result: SyncResult,
): Promise<void> {
  try {
    if (result.errors.length > 0) throw new Error('Remote deletion deferred until uploads and reconciliation finish successfully');
    const deleteFiles = localOnlyDeletes.flatMap((path) => {
      const expectedHash = context.localManifest.getEntry(path)?.hash;
      return expectedHash ? [{ path, expectedHash, expectedRevision: context.localManifest.getEntry(path)?.revision }] : [];
    });
    const missingExpectedPaths = localOnlyDeletes.filter(
      (path) => !context.localManifest.getEntry(path)?.hash,
    );
    for (const path of missingExpectedPaths) {
      recordSyncError(result, `Missing remote version for delete`, path);
    }
    const deleteResult = deleteFiles.length > 0
      ? await deleteFilesInBatches(context.api, deleteFiles, path => assertLocalFileAbsent(context.vault, path))
      : { success: true, deleted: [], errors: [] };
    for (const path of deleteResult.deleted) {
      context.localManifest.removeEntry(path);
      result.deleted++;
      result.deletedPaths.push(path);
    }

    if (!deleteResult.success) {
      const deletedSet = new Set(deleteResult.deleted);
      const failures: MutationFailure[] = deleteResult.errors && deleteResult.errors.length > 0
        ? deleteResult.errors
        : localOnlyDeletes
            .filter((path) => !deletedSet.has(path))
            .map((path) => ({ path, error: "Batch delete failed" }));

      const versionConflicts = failures.filter(
        (failure) => failure.code === 'version_conflict' || failure.status === 409,
      );
      const otherFailures = failures.filter((failure) => !versionConflicts.includes(failure));
      for (const failure of otherFailures) {
        recordSyncError(result, `${failure.error}`, failure.path);
      }
      if (versionConflicts.length > 0) {
        if (context.reconcileVersionConflicts) {
          await context.reconcileVersionConflicts(
            versionConflicts.map((failure) => `delete:${failure.path}`),
            result,
          );
        } else {
          for (const failure of versionConflicts) {
            recordSyncError(result, `${failure.error}`, failure.path);
          }
        }
      }
    }
  } catch (error) {
    const errMsg = errorMessage(error);
    for (const path of localOnlyDeletes) {
      recordSyncError(result, `${errMsg}`, path);
    }
  }
}
