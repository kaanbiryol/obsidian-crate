import { recordSyncError, SyncIssueError, withSyncFileContext } from '../issues';
import { INITIAL_IMPORT_MAX_FILES } from '@/protocol/initial-import';
import { BATCH_FILE_SIZE_LIMIT, MAX_FILE_SIZE_BYTES } from '@/protocol/sync-limits';
import type { SyncApiClient } from '../worker-api/client';
import type { PreparedUpload, SyncResult, SyncWork } from '../types';
import type { TransferContext } from '../transfer/types';
import { getAllVaultFiles } from '../local/file-discovery';
import { partitionSkippedUploads } from '../local/local-file-changes';
import { getTransferBudgetBytes, prepareUploadChunks } from '../transfer/budget';

const IMPORT_UPLOAD_CONCURRENCY = 3;
const IMPORT_SAVE_FILES = 256;
const IMPORT_SAVE_INTERVAL_MS = 5_000;
import { chunkPreparedUploads, prepareUploadFromVaultFile } from '../transfer/prepare';
import { UNVERIFIED_MODIFIED } from '../transfer/applied-content';
import { createPathRecord } from '@/protocol/path-record';
import type { FileEntry } from '@/protocol/sync-types';

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

export const ANOTHER_DEVICE_IMPORTING = 'Another device is uploading this vault for the first time. Let it finish, then sync. If this device started it, select Replace server files.';
export const FIRST_UPLOAD_UNFINISHED = 'The first upload of this vault has not finished. Select Sync now on the device that started it, then sync here.';

/** Resuming a first upload prunes server files the importing device lacks, so
 * ordinary uploads and deletes wait until it finishes. */
export async function assertNoOpenInitialImport(api: { initialImport?: Pick<SyncApiClient['initialImport'], 'begin'> }): Promise<void> {
	if ((await api.initialImport?.begin())?.state === 'importing') throw new Error(FIRST_UPLOAD_UNFINISHED);
}

/** The committed remote inventory is the checkpoint; initial uploads need no receipt journal. */
/** Preparation checked this mtime around its read, as ordinary uploads do. */
const verifiedModified = (upload: PreparedUpload) => upload.mtime === undefined ? UNVERIFIED_MODIFIED : new Date(upload.mtime).toISOString();
const batchBytes = (batch: PreparedUpload[]) => batch.reduce((sum, file) => sum + file.content.byteLength, 0);

/** Small files share requests within the batch limits; larger files go one per request. */
function importBatches(prepared: PreparedUpload[]): PreparedUpload[][] {
	return [
		...chunkPreparedUploads(prepared.filter(file => file.size < BATCH_FILE_SIZE_LIMIT), INITIAL_IMPORT_MAX_FILES),
		...prepared.filter(file => file.size >= BATCH_FILE_SIZE_LIMIT).map(file => [file]),
	];
}

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
	// Skipped files are reported, not uploaded; a server row they already have stays as it is.
	const { eligible: files, skipped } = partitionSkippedUploads(local, transfer.encrypted());
	for (const issue of skipped) {
		(result.issues ??= []).push(issue);
		const existing = remote.files[issue.path!];
		if (existing) inventory[issue.path!] = existing;
	}
	let completed = 0;
	let saved = 0;
	let savedAt = Date.now();
	try {
		const maxBytes = getTransferBudgetBytes();
		// Bytes of prepared files that wait for or are in an upload request.
		let retained = 0;
		const source = prepareUploadChunks(files, async file => {
			context.throwIfDestroyed();
			const upload = await prepareUploadFromVaultFile(transfer, file, { force: true, expectedHash: remote.files[file.path]?.hash ?? null });
			if (!upload) throw new Error(`Could not prepare ${file.path}`);
			const existing = remote.files[file.path];
			if (existing?.hash === upload.hash && existing.size === upload.size && existing.revision) {
				inventory[file.path] = existing;
				transfer.localManifest.setEntry(file.path, { ...existing, modified: verifiedModified(upload) });
				await transfer.markdownBaseCache.putBase(file.path, upload.hash, upload.content);
				completed++;
				return null;
			}
			return upload;
		}, maxBytes, INITIAL_IMPORT_MAX_FILES, () => maxBytes - retained);
		const queue: PreparedUpload[][] = [];
		let exhausted = false;
		let producing: Promise<void> | undefined;
		let failure: { error: unknown } | undefined;
		const waiting: Array<() => void> = [];
		const wake = () => { for (const resolve of waiting.splice(0)) resolve(); };
		const stopped = () => failure !== undefined || result.errors.length > 0;
		// Prepare one request per slot ahead while the byte budget still holds a
		// maximum-size file beside the prepared files every request retains.
		const produce = () => producing ??= (async () => {
			while (!exhausted && !stopped() && queue.length < IMPORT_UPLOAD_CONCURRENCY && maxBytes - retained >= MAX_FILE_SIZE_BYTES) {
				const next = await source.next();
				if (next.done) { exhausted = true; break; }
				for (const batch of importBatches(next.value)) {
					retained += batchBytes(batch);
					queue.push(batch);
				}
				wake();
			}
		})().catch((error: unknown) => { failure ??= { error }; }).finally(() => {
			producing = undefined;
			// A producer stopped by the budget resumes when an upload releases it.
			if (exhausted || failure) wake();
		});
		const uploadBatch = (batch: PreparedUpload[]) => withSyncFileContext(batch.map(file => file.path), async () => {
			context.throwIfDestroyed();
			context.report({ phase: 'uploading', current: completed, total: files.length });
			const response = await context.api.initialImport.upload(session.token, batch);
			if (response.results.length !== batch.length || new Set(response.results.map(file => file.path)).size !== batch.length) throw new Error('Invalid initial upload results');
			for (const upload of batch) {
				const receipt = response.results.find(file => file.path === upload.path);
				if (!receipt?.success) { recordSyncError(result, `${receipt?.error ?? 'Upload interrupted'}`, upload.path); continue; }
				if (receipt.hash !== upload.hash || typeof receipt.revision !== 'string' || !receipt.revision) throw new SyncIssueError('Invalid initial upload metadata', [{ path: upload.path, message: 'Invalid initial upload metadata', code: 'transfer-unverified' }]);
				const entry = { hash: upload.hash, size: upload.size, revision: receipt.revision, modified: verifiedModified(upload) };
				transfer.localManifest.setEntry(upload.path, entry);
				inventory[upload.path] = entry;
				await transfer.markdownBaseCache.putBase(upload.path, upload.hash, upload.content);
				result.uploaded++;
				result.uploadedPaths.push(upload.path);
				completed++;
			}
		});
		// Each slot takes the next prepared request as soon as its own finishes.
		const worker = async () => {
			while (!stopped()) {
				const batch = queue.shift();
				if (!batch) {
					if (exhausted && !producing) return;
					const changed = new Promise<void>(resolve => waiting.push(resolve));
					void produce();
					await changed;
					continue;
				}
				void produce();
				try { await uploadBatch(batch); }
				catch (error) { failure ??= { error }; return; }
				finally { retained -= batchBytes(batch); wake(); }
				if (stopped()) return;
				progress?.(completed, files.length);
				// The committed server inventory is the resume point, so the local
				// checkpoint only needs to keep up periodically.
				if (completed - saved >= IMPORT_SAVE_FILES || Date.now() - savedAt >= IMPORT_SAVE_INTERVAL_MS) {
					saved = completed;
					savedAt = Date.now();
					try { await context.save(); }
					catch (error) { failure ??= { error }; return; }
				}
			}
		};
		try {
			await Promise.all(Array.from({ length: IMPORT_UPLOAD_CONCURRENCY }, worker));
		} finally {
			while (producing) await producing;
			await source.return(undefined);
		}
		if (failure) throw failure.error;
		if (result.errors.length) return result;
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
