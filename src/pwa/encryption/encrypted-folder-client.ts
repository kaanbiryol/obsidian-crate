import type { EncryptionContext } from '@/encryption/envelope';
import type { FileEncryptionAuthority } from '@/encryption/file-codec';
import { openVerifiedInventoryFile, type EncryptedInventoryFile } from '@/encryption/file-inventory';
import { resolveEncryptedPath } from '@/encryption/path-binding';
import type { PathTags } from '@/encryption/path-tags';

/** Reminders and Reading serve the same encrypted folder routes under their own prefix. */
export type EncryptedFolderPrefix = '/reminders' | '/reading';

/** One inventory page of the server folder `wireFolder`, after server path `after`. */
export function encryptedFilesPath(prefix: EncryptedFolderPrefix, wireFolder: string, after?: string): string {
	const query = new URLSearchParams({ folderPath: wireFolder });
	if (after) query.set('after', after);
	return `${prefix}/encrypted-files?${query}`;
}

/** One listed file's ciphertext, at the revision the inventory listed. */
export function encryptedFilePath(prefix: EncryptedFolderPrefix, wireFolder: string, file: { path: string; revision: string }): string {
	return `${prefix}/encrypted-file?${new URLSearchParams({ folderPath: wireFolder, path: file.path, revision: file.revision })}`;
}

/** The envelope context of an operation's encrypted acknowledgment.
 * 'reminder' is the shared envelope purpose for operation objects in every scope, Reading
 * included. The plugin binds it into each protected header, so it is a wire value, not a
 * feature label: renaming it breaks decryption with the plugin and stored ciphertext. */
export function encryptedOperationContext(vaultId: string, scopeId: string, operationId: string): EncryptionContext {
	return { vaultId, scopeId, objectId: operationId, purpose: 'reminder' };
}

/** Opens a downloaded note listed as `file`. Its metadata must bind its plaintext path to
 * that server path. Size limits and failed downloads stay with each feature. */
export async function openEncryptedNote(response: Response, file: EncryptedInventoryFile, options: {
	authority: FileEncryptionAuthority; integrityError: string; paths: PathTags;
}) {
	return openVerifiedInventoryFile(new Uint8Array(await response.arrayBuffer()), file, options.authority, options.integrityError,
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
