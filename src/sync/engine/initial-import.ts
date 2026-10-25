import { recordSyncError, skippedFileIssue, SyncIssueError, withSyncFileContext } from '../issues';
import { INITIAL_IMPORT_MAX_FILES } from '@/protocol/initial-import';
import { BATCH_FILE_SIZE_LIMIT, BATCH_UPLOAD_MAX_BYTES } from '@/protocol/sync-limits';
import type { SyncApiClient } from '../worker-api/client';
import type { PreparedUpload, SyncResult, SyncWork } from '../types';
import type { TransferContext } from '../transfer/types';
import { getAllVaultFiles } from '../local/file-discovery';
import { isOversizedSyncFile } from '../local/local-file-changes';
import { pipelineUploadChunks } from '../transfer/budget';
import { prepareUploadFromVaultFile } from '../transfer/prepare';
import { createPathRecord } from '@/protocol/path-record';
import type { FileEntry } from '@/protocol/sync-types';
import { UNVERIFIED_MODIFIED } from '../transfer/applied-content';

interface ImportContext {
  prepareReminderScope?(): Promise<void>;
  transfer: TransferContext;
  api: SyncApiClient;
  shouldIgnore(path: string): boolean;
  throwIfDestroyed(): void;
  save(): Promise<void>;
  setLastSeq(seq: number): void;
  report(work: SyncWork): void;
  getImportToken(): string | undefined;
  setImportToken(token: string | undefined): void;
}

export const ANOTHER_DEVICE_IMPORTING = 'Another device is uploading this vault for the first time. Let it finish, then sync.';

/** The committed remote inventory is the checkpoint; initial uploads need no receipt journal. */
export async function runInitialImport(context: ImportContext, result: SyncResult, progress?: (current: number, total: number) => void): Promise<SyncResult | null> {
  context.throwIfDestroyed();
  context.report({ phase: 'server' });
  const session = await context.api.initialImport?.begin();
  if (!session) return null;
  if (session.state === 'complete') {
    // Sync corrections before waiting: a local edit may repair a failed reminder source.
    return null;
  }
  const transfer = context.transfer;
  context.report({ phase: 'scanning' });
  const local = await getAllVaultFiles(transfer.vault, path => context.shouldIgnore(path), () => context.throwIfDestroyed());
  const remote = await context.api.getManifest();
  // Only the device that started an import prunes or replaces its files. Without the
  // token, an import is this device's only while it holds every server file's revision:
  // the import is empty, or this device uploaded those files before tokens were kept.
  if (context.getImportToken() !== session.token) {
    const owned = Object.entries(remote.files).every(([path, entry]) => !!entry.revision && transfer.localManifest.getEntry(path)?.revision === entry.revision);
    if (!owned) throw new Error(ANOTHER_DEVICE_IMPORTING);
    context.setImportToken(session.token);
    await context.save();
  }
  const localPaths = new Set(local.map(file => file.path));
  const obsolete = Object.keys(remote.files).filter(path => !localPaths.has(path));
  await context.api.initialImport.prune(session.token, obsolete.map(path => ({ path, hash: remote.files[path]!.hash })));
  for (const path of obsolete) transfer.localManifest.removeEntry(path);
  const inventory = createPathRecord<FileEntry>();
  // Oversized files are reported, not uploaded; a server row they already have stays as it is.
  const files = local.filter(file => !isOversizedSyncFile(file));
  for (const file of local.filter(isOversizedSyncFile)) {
    (result.issues ??= []).push(skippedFileIssue(file.path));
    const existing = remote.files[file.path];
    if (existing) inventory[file.path] = existing;
  }
  let completed = 0;
  try {
    // Prepare the next chunk while the current one uploads, within the byte budget.
    const chunks = pipelineUploadChunks(files, async file => {
      context.throwIfDestroyed();
      const upload = await prepareUploadFromVaultFile(transfer, file, { force: true, expectedHash: remote.files[file.path]?.hash ?? null });
      if (!upload) throw new Error(`Could not prepare ${file.path}`);
      const existing = remote.files[file.path];
      if (existing?.hash === upload.hash && existing.size === upload.size && existing.revision) {
        inventory[file.path] = existing;
        transfer.localManifest.setEntry(file.path, { ...existing, modified: UNVERIFIED_MODIFIED });
        await transfer.markdownBaseCache?.putBase(file.path, upload.hash, upload.content);
        completed++;
        return null;
      }
      return upload;
    });
    for await (const prepared of chunks) {
      const small = prepared.filter(file => file.size < BATCH_FILE_SIZE_LIMIT);
      const batches: PreparedUpload[][] = [];
      let batch: PreparedUpload[] = [];
      let batchBytes = 0;
      for (const file of small) {
        if (batch.length >= INITIAL_IMPORT_MAX_FILES || batchBytes + file.size > BATCH_UPLOAD_MAX_BYTES) {
          batches.push(batch); batch = []; batchBytes = 0;
        }
        batch.push(file); batchBytes += file.size;
      }
      if (batch.length) batches.push(batch);
      batches.push(...prepared.filter(file => file.size >= BATCH_FILE_SIZE_LIMIT).map(file => [file]));
      await transfer.runConcurrent(batches.map(batch => () => withSyncFileContext(batch.map(file => file.path), async () => {
        context.throwIfDestroyed();
        if (result.errors.length) return;
        context.report({ phase: 'uploading', current: completed, total: files.length });
        const response = await context.api.initialImport.upload(session.token, batch);
        if (response.results.length !== batch.length || new Set(response.results.map(file => file.path)).size !== batch.length) throw new Error('Invalid initial upload results');
        for (const upload of batch) {
          const receipt = response.results.find(file => file.path === upload.path);
          if (!receipt?.success) { recordSyncError(result, `${receipt?.error ?? 'Upload interrupted'}`, upload.path); continue; }
          if (receipt.hash !== upload.hash || typeof receipt.revision !== 'string' || !receipt.revision) throw new SyncIssueError('Invalid initial upload metadata', [{ path: upload.path, message: 'Invalid initial upload metadata', code: 'transfer-unverified' }]);
          const entry = { hash: upload.hash, size: upload.size, revision: receipt.revision, modified: UNVERIFIED_MODIFIED };
          transfer.localManifest.setEntry(upload.path, entry);
          inventory[upload.path] = entry;
          await transfer.markdownBaseCache?.putBase(upload.path, upload.hash, upload.content);
          result.uploaded++;
          result.uploadedPaths.push(upload.path);
          completed++;
        }
      })), 3);
      if (result.errors.length) return result;
      await context.save();
      progress?.(completed, files.length);
    }
    context.throwIfDestroyed();
    progress?.(completed, files.length);
    context.report({ phase: 'saving' });
    await context.save();
    // Establish the selected folder before sealing creates the reminder-readiness marker.
    context.report({ phase: 'reminders' });
    await context.prepareReminderScope?.();
    context.throwIfDestroyed();
    context.report({ phase: 'saving' });
    context.setLastSeq(await context.api.initialImport.finish(session.token, inventory));
    context.setImportToken(undefined);
    await context.save();
    return result;
  } finally { await context.save(); }
}
