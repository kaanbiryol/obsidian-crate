import { sealFileForVault } from '@/encryption/sealed-file';
import { sealedReadingCardData } from '@/reading/core/reading-card';
import { sha256Hex } from '@/platform/sha256';
import { readingCapturePath } from '@/reading/core/filename';
import { parseReadingNote } from '@/reading/core/notes';
import { createOpaqueWireName } from '@/protocol/encrypted-path';
import { readEncryptionState } from '../encryption/state';
import { stageMarkdownFile } from '../sync/markdown-file-staging';
import { commitStagedFile } from '../sync/mutations';
import type { Env } from '../types';
import { policy } from './common';

/** A finished Reading note for an encrypted vault, built outside the coordinator. */
export interface SealedReadingNote { id: string; content: string; folder: string; generation: string }

/** Runs under the coordinator lock. Without the path key the server cannot tag a
 * name, so the note gets a random server name in the tagged Reading folder and its
 * readable name is sealed inside it. The plaintext is never stored. */
export async function commitSealedReadingNote(env: Env, note: SealedReadingNote): Promise<boolean> {
	const state = await readEncryptionState(env.DB);
	const current = await policy(env.DB);
	if (state?.mode !== 'active' || current?.folder_path !== note.folder || current.generation !== note.generation) return false;
	const item = parseReadingNote(note.content)!;
	const sealedPath = await readingCapturePath(current.folder_path, { title: item.title, url: item.source_url }, note.id, () => false);
	const path = `${current.folder_path}/${createOpaqueWireName()}`;
	const recipient = { vaultId: state.vaultId, keyId: state.seal.keyId, publicKey: state.seal.publicKey }, bytes = new TextEncoder().encode(note.content);
	// The card lists the note at once; it has no search terms until a device saves the note again.
	const publicData = await sealedReadingCardData({ ...item, path: sealedPath }, path, await sha256Hex(bytes), recipient);
	const sealed = await sealFileForVault({ path: sealedPath, content: bytes, contentType: 'text/markdown', publicData }, recipient);
	const content = new TextDecoder().decode(sealed.bytes);
	const staged = await stageMarkdownFile(env.BUCKET, env.DB, path, content, null, true);
	const committed = await commitStagedFile(env.BUCKET, env.DB, { ...staged, content, encryptionState: state, sealedReadingFolder: current.folder_path });
	return committed.committed;
}
