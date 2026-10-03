import type CratePlugin from '../plugin/CratePlugin';
import { readFolderMoves } from '../plugin/encryption-folder-move-journal';
import { LocalManifest } from './manifest';
import { getCheckpointAuthority } from './worker-url';
import { shouldIgnoreSyncPath } from './engine-ignore';

/** Called only inside runEncryptionSetup, after the stopped engine's I/O settles. */
export async function checkpointEncryptionRenames(plugin: CratePlugin): Promise<void> {
  const moves = readFolderMoves(plugin.secretStorage).moves;
  if (!moves.length) return;
  const matcher = { ignoredDirPrefixes: [`${plugin.manifest.dir}/`], ignorePatterns: plugin.settings.ignorePatterns, patternCache: new Map<string, RegExp>() };
  matcher.ignoredDirPrefixes.push(...matcher.ignorePatterns.filter(pattern => pattern.endsWith('/')));
  const manifest = new LocalManifest(plugin.app, plugin.manifest, getCheckpointAuthority(plugin.settings));
  try {
    await manifest.load();
    manifest.applyJournalRenames(moves.map(move => ({ ...move, rename: move.rename !== false
      && !shouldIgnoreSyncPath(move.from, matcher) && !shouldIgnoreSyncPath(move.to, matcher) })));
    await manifest.save();
  } finally { await manifest.close(); }
}
