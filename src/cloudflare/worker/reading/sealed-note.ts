import { sealFileForVault } from '@/encryption/sealed-file';
import { readEncryptionState } from '../encryption/state';
import { stageMarkdownFile } from '../sync/markdown-file-staging';
import { commitStagedFile } from '../sync/mutations';
import type { Env } from '../types';
import { capturePath } from './captures';
import { policy } from './common';

/** A finished Reading note for an encrypted vault, built outside the coordinator. */
export interface SealedReadingNote { id: string; content: string; folder: string; generation: string }

/** Runs under the coordinator lock. Seals the note to the vault seal key at a
 * generic path and commits it as a new file; the plaintext is never stored. */
export async function commitSealedReadingNote(env: Env, note: SealedReadingNote): Promise<boolean> {
  const state = await readEncryptionState(env.DB);
  const current = await policy(env.DB);
  if (state?.mode !== 'active' || current?.folder_path !== note.folder || current.generation !== note.generation) return false;
  const path = await capturePath(env, current.folder_path, 'Article', note.id);
  const sealed = await sealFileForVault({ path, content: new TextEncoder().encode(note.content), contentType: 'text/markdown' },
    { vaultId: state.vaultId, keyId: state.seal.keyId, publicKey: state.seal.publicKey });
  const content = new TextDecoder().decode(sealed.bytes);
  const staged = await stageMarkdownFile(env.BUCKET, env.DB, path, content, null, true);
  const committed = await commitStagedFile(env.BUCKET, env.DB, { ...staged, content, previousFile: null, encryptionState: state, sealedReadingFolder: current.folder_path });
  return committed.committed;
}
