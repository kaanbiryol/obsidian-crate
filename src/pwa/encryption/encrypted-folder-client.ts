import type { EncryptionContext } from '@/encryption/envelope';
import type { FileEncryptionAuthority } from '@/encryption/file-codec';
import { openVerifiedInventoryFile, type EncryptedInventoryFile } from '@/encryption/file-inventory';
import { resolveEncryptedPath } from '@/encryption/path-binding';
import type { PathTags } from '@/encryption/path-tags';
import { BATCH_DOWNLOAD_MAX_BYTES, BATCH_DOWNLOAD_MAX_FILES } from '@/protocol/sync-limits';
import { mapBounded } from '@/platform/map-bounded';

/** Reminders and Reading serve the same encrypted folder routes under their own prefix. */
export type EncryptedFolderPrefix = '/reminders' | '/reading';

/** One inventory page of the server folder `wireFolder`, after the opaque cursor `after`,
 * or with `since` the notes changed after that delta base. */
export function encryptedFilesPath(prefix: EncryptedFolderPrefix, wireFolder: string, { after, since }: { after?: string; since?: string } = {}): string {
	const query = new URLSearchParams({ folderPath: wireFolder });
	if (after) query.set('after', after);
	if (since) query.set('since', since);
	return `${prefix}/encrypted-files?${query}`;
}

/** One listed file's ciphertext, at the revision the inventory listed. */
export function encryptedFilePath(prefix: EncryptedFolderPrefix, wireFolder: string, file: { path: string; revision: string }): string {
	return `${prefix}/encrypted-file?${new URLSearchParams({ folderPath: wireFolder, path: file.path, revision: file.revision })}`;
}

/** A listed note's ciphertext, or why the Worker did not return it: `version_conflict` and
 * `not_found` mean the note changed after it was listed. */
export type DownloadedNote =
	| { file: EncryptedInventoryFile; bytes: Uint8Array<ArrayBuffer> }
	| { file: EncryptedInventoryFile; code: string; error: string };

/** Downloads listed notes in batches within the Worker's file and byte limits, each at the
 * revision the inventory listed, and hands each to `open` as its batch arrives, so only
 * batches in flight hold ciphertext. Callers leave out notes over their size limit.
 * `failed` reports a refused batch and must throw. Results keep the order of `files`. */
export async function downloadEncryptedNotes<T>(send: (path: string, body: string) => Promise<Response>, prefix: EncryptedFolderPrefix, wireFolder: string,
	files: readonly EncryptedInventoryFile[], failed: (response: Response) => Promise<never>, open: (note: DownloadedNote) => Promise<T>): Promise<T[]> {
	const batches: EncryptedInventoryFile[][] = [];
	let bytes = 0;
	for (const file of files) {
		const last = batches.at(-1);
		if (!last || last.length === BATCH_DOWNLOAD_MAX_FILES || bytes + file.size > BATCH_DOWNLOAD_MAX_BYTES) { batches.push([file]); bytes = file.size; }
		else { last.push(file); bytes += file.size; }
	}
	const results = await mapBounded(batches, DOWNLOAD_BATCH_CONCURRENCY, async batch => {
		const response = await send(`${prefix}/encrypted-files/download`, JSON.stringify({ folderPath: wireFolder, files: batch.map(({ path, revision }) => ({ path, revision })) }));
		if (!response.ok) return failed(response);
		const { files: entries } = await response.json() as { files?: unknown };
		if (!Array.isArray(entries) || entries.length !== batch.length) throw new Error('Invalid encrypted note download');
		const notes = batch.map((file, index): DownloadedNote => {
			const entry = entries[index] as Record<string, unknown> | null;
			if (!entry || entry.path !== file.path || entry.revision !== file.revision) throw new Error('Invalid encrypted note download');
			if (typeof entry.content === 'string') return { file, bytes: new TextEncoder().encode(entry.content) };
			if (typeof entry.code !== 'string' || typeof entry.error !== 'string') throw new Error('Invalid encrypted note download');
			return { file, code: entry.code, error: entry.error };
		});
		return Promise.all(notes.map(open));
	});
	return results.flat();
}
// Each batch already keeps the Worker's R2 reads in flight, so a few batches suffice.
const DOWNLOAD_BATCH_CONCURRENCY = 3;

/** The envelope context of an operation's encrypted acknowledgment.
 * 'reminder' is the shared envelope purpose for operation objects in every scope, Reading
 * included. The plugin binds it into each protected header, so it is a wire value, not a
 * feature label: renaming it breaks decryption with the plugin and stored ciphertext. */
export function encryptedOperationContext(vaultId: string, scopeId: string, operationId: string): EncryptionContext {
	return { vaultId, scopeId, objectId: operationId, purpose: 'reminder' };
}

/** Opens a downloaded note listed as `file`. Its metadata must bind its plaintext path to
 * that server path. Size limits and failed downloads stay with each feature. */
export async function openEncryptedNote(download: Response | Uint8Array<ArrayBuffer>, file: EncryptedInventoryFile, options: {
	authority: FileEncryptionAuthority; integrityError: string; paths: PathTags;
}) {
	const bytes = download instanceof Uint8Array ? download : new Uint8Array(await download.arrayBuffer());
	return openVerifiedInventoryFile(bytes, file, options.authority, options.integrityError,
		metadataPath => resolveEncryptedPath(options.paths, file.path, metadataPath));
}

interface CommitAnswer { encrypted?: unknown; error?: string; code?: string }
/** `conflict` is the Worker's `version_conflict`: it replays a committed copy of the
 * operation before reporting one, so the attempt never committed. A `failed` response
 * is unread unless `answer` holds its body. */
export type EncryptedCommitOutcome =
	| { kind: 'committed'; encrypted: string }
	| { kind: 'conflict'; response: Response; answer: CommitAnswer }
	| { kind: 'failed'; response: Response; answer?: CommitAnswer };

/** Sends one stored attempt to `${prefix}/encrypted-commit`. Each feature keeps its own
 * attempt storage and decides when a conflicting attempt is rebuilt. */
export async function postEncryptedCommit(send: (path: string, body: string) => Promise<Response>, prefix: EncryptedFolderPrefix, body: string): Promise<EncryptedCommitOutcome> {
	const response = await send(`${prefix}/encrypted-commit`, body);
	if (response.status === 409) {
		// A copy, so a conflict that is reported as is still has its body. A proxy's
		// non-JSON 409 is not the Worker's conflict, so it fails like any other refusal.
		const answer = await response.clone().json().catch(() => null) as CommitAnswer | null;
		if (answer?.code === 'version_conflict') return { kind: 'conflict', response, answer };
	}
	if (!response.ok) return { kind: 'failed', response };
	const answer = await response.json() as CommitAnswer;
	return typeof answer.encrypted === 'string' ? { kind: 'committed', encrypted: answer.encrypted } : { kind: 'failed', response, answer };
}
