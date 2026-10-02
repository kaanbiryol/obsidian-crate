import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gh, releases, selectRelease, shortcutName, assetName, metadataName, legacyAssetName, legacyMetadataName, sourceHash, validateTag, verifyShortcut } from './shortcut-release.mjs';

const legacy = process.argv.includes('--legacy');
const [mode, destination, tag, ...extra] = process.argv.slice(2).filter(arg => arg !== '--legacy');
const names = legacy ? { assetName: legacyAssetName, metadataName: legacyMetadataName } : { assetName, metadataName };
if (!['published', 'draft'].includes(mode) || !destination || extra.length || (mode === 'draft' && !tag)) {
  throw new Error('Usage: node scripts/download-release-shortcut.mjs <published|draft> <destination> [tag] [--legacy]');
}
if (tag) validateTag(tag);
const available = releases();
if (legacy && mode === 'published' && !tag && !available.some(item => !item.draft && item.assets.some(asset => asset.name === names.metadataName))) {
  console.log('No legacy shortcut release exists; v1 has no artifact to preserve.');
  process.exit(0);
}
const release = selectRelease(available, tag, names);
if (release.draft !== (mode === 'draft')) throw new Error(`Expected a ${mode} release.`);
const temporary = await mkdtemp(join(tmpdir(), 'crate-release-shortcut-'));
try {
  gh(['release', 'download', release.tag_name, '--pattern', names.assetName, '--pattern', names.metadataName, '--dir', temporary]);
  const metadata = JSON.parse(await readFile(join(temporary, names.metadataName), 'utf8'));
  const bytes = await readFile(join(temporary, names.assetName));
  verifyShortcut(metadata, bytes, release.tag_name, mode === 'draft' ? await sourceHash() : undefined, names.assetName);
  await mkdir(destination, { recursive: true });
  await copyFile(join(temporary, names.assetName), join(destination, shortcutName));
  console.log(`Verified shortcut from ${release.tag_name}: ${metadata.sha256}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
