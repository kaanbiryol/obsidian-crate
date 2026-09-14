import { importInventoryHash, INITIAL_IMPORT_MAX_FILES } from '@/protocol/initial-import';
import { BATCH_FILE_SIZE_LIMIT, BATCH_UPLOAD_MAX_BYTES } from '@/protocol/sync-limits';
import type { SyncApiClient } from './api';
import type { PreparedUpload, SyncResult, SyncWork } from './types';
import type { TransferContext } from './transfer-types';
import { getAllVaultFiles } from './file-discovery';
import { prepareUploadChunks } from './transfer-budget';
import { prepareUploadFromVaultFile } from './transfer-prepare';
import { createPathRecord } from '@/protocol/path-record';
import type { FileEntry } from '@/protocol/sync-types';
import { UNVERIFIED_MODIFIED } from './applied-content';

interface ImportContext {
  prepareReminderScope?(): Promise<void>;
  transfer: TransferContext;
  api: SyncApiClient;
  shouldIgnore(path: string): boolean;
  throwIfDestroyed(): void;
  save(): Promise<void>;
  setLastSeq(seq: number): void;
  report(work: SyncWork): void;
}

/** The committed remote inventory is the checkpoint; initial uploads need no receipt journal. */
export async function runInitialImport(context: ImportContext, result: SyncResult, progress?: (current: number, total: number) => void): Promise<SyncResult | null> {
  const session = await context.api.initialImport?.begin();
  if (!session) return null;
  if (session.state === 'complete') {
    // Sync corrections before waiting: a local edit may repair a failed reminder source.
    return null;
  }
  const transfer = context.transfer;
  context.report({ phase: 'scanning' });
  const local = await getAllVaultFiles(transfer.vault, path => context.shouldIgnore(path));
  const remote = await context.api.getManifest();
  const localPaths = new Set(local.map(file => file.path));
  const obsolete = Object.keys(remote.files).filter(path => !localPaths.has(path));
  await context.api.initialImport.prune(session.token, obsolete.map(path => ({ path, hash: remote.files[path]!.hash })));
  for (const path of obsolete) transfer.localManifest.removeEntry(path);
  const inventory = createPathRecord<FileEntry>();
  let completed = 0;
  try {
    const chunks = prepareUploadChunks(local, async file => {
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
      await transfer.runConcurrent(batches.map(batch => async () => {
        context.throwIfDestroyed();
        if (result.errors.length) return;
        context.report({ phase: 'uploading', current: completed, total: local.length });
        const response = await context.api.initialImport.upload(session.token, batch);
        if (response.results.length !== batch.length || new Set(response.results.map(file => file.path)).size !== batch.length) throw new Error('Invalid initial upload results');
        for (const upload of batch) {
          const receipt = response.results.find(file => file.path === upload.path);
          if (!receipt?.success) { result.errors.push(`${upload.path}: ${receipt?.error ?? 'Upload interrupted'}`); continue; }
          if (receipt.hash !== upload.hash || typeof receipt.revision !== 'string' || !receipt.revision) throw new Error('Invalid initial upload metadata');
          const entry = { hash: upload.hash, size: upload.size, revision: receipt.revision, modified: UNVERIFIED_MODIFIED };
          transfer.localManifest.setEntry(upload.path, entry);
          inventory[upload.path] = entry;
          await transfer.markdownBaseCache?.putBase(upload.path, upload.hash, upload.content);
          result.uploaded++;
          result.uploadedPaths.push(upload.path);
          completed++;
        }
      }), 3);
      if (result.errors.length) return result;
      await context.save();
      progress?.(completed, local.length);
    }
    context.throwIfDestroyed();
    progress?.(completed, local.length);
    context.report({ phase: 'saving' });
    await context.save();
    // Establish the selected folder before sealing creates the reminder-readiness marker.
    context.report({ phase: 'reminders' });
    await context.prepareReminderScope?.();
    context.throwIfDestroyed();
    context.report({ phase: 'saving' });
    context.setLastSeq(await context.api.initialImport.finish(session.token, await importInventoryHash(inventory)));
    await context.save();
    return result;
  } finally { await context.save(); }
}
