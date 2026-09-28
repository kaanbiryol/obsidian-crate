import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gh, releases, selectRelease, shortcutName, assetName, metadataName, sourceHash, validateTag, verifyShortcut } from './shortcut-release.mjs';

const [mode, destination, tag, ...extra] = process.argv.slice(2);
if (!['published', 'draft'].includes(mode) || !destination || extra.length || (mode === 'draft' && !tag)) {
  throw new Error('Usage: node scripts/download-release-shortcut.mjs <published|draft> <destination> [tag]');
}
if (tag) validateTag(tag);
const release = selectRelease(releases(), tag);
if (release.draft !== (mode === 'draft')) throw new Error(`Expected a ${mode} release.`);
const temporary = await mkdtemp(join(tmpdir(), 'crate-release-shortcut-'));
try {
  gh(['release', 'download', release.tag_name, '--pattern', assetName, '--pattern', metadataName, '--dir', temporary]);
  const metadata = JSON.parse(await readFile(join(temporary, metadataName), 'utf8'));
  const bytes = await readFile(join(temporary, assetName));
  verifyShortcut(metadata, bytes, release.tag_name, mode === 'draft' ? await sourceHash() : undefined);
  await mkdir(destination, { recursive: true });
  await copyFile(join(temporary, assetName), join(destination, shortcutName));
  console.log(`Verified shortcut from ${release.tag_name}: ${metadata.sha256}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
