import type CratePlugin from '../../plugin/CratePlugin';
import { readFolderMoves } from './folder-move-journal';
import { LocalManifest } from '../manifest/manifest';
import { getCheckpointAuthority } from '../connection/worker-url';
import { createIgnoreMatcherContext, shouldIgnoreSyncPath } from '../engine/ignore';

/** Called only inside runEncryptionSetup, after the stopped engine's I/O settles. */
export async function checkpointEncryptionRenames(plugin: CratePlugin): Promise<void> {
  const moves = readFolderMoves(plugin.secretStorage).moves;
  if (!moves.length) return;
  const matcher = createIgnoreMatcherContext([`${plugin.manifest.dir}/`], plugin.settings.ignorePatterns);
  const manifest = new LocalManifest(plugin.app, plugin.manifest, getCheckpointAuthority(plugin.settings));
  try {
    await manifest.load();
    manifest.applyJournalRenames(moves.map(move => ({ ...move, rename: move.rename !== false
      && !shouldIgnoreSyncPath(move.from, matcher) && !shouldIgnoreSyncPath(move.to, matcher) })));
    await manifest.save();
  } finally { await manifest.close(); }
}
