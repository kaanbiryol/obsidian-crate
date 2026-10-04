import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gh, releases, selectRelease, shortcutName, assetName, metadataName, sourceHash, validateTag, verifyShortcut } from './shortcut-release.mjs';
import { shortcutInstallPage } from './shortcut-install-page.mjs';

export async function downloadShortcut(args, { getReleases = releases, downloadRelease = (tag, names, directory) =>
  gh(['release', 'download', tag, '--pattern', names.assetName, '--pattern', names.metadataName, '--dir', directory]) } = {}) {
  const installPage = args.includes('--install-page');
  const [mode, destination, tag, ...extra] = args.filter(arg => arg !== '--install-page');
  const names = { assetName, metadataName };
  if (!['published', 'draft'].includes(mode) || !destination || extra.length || (mode === 'draft' && !tag)
    || (installPage && (mode !== 'published' || tag))) {
    throw new Error('Usage: node scripts/download-release-shortcut.mjs <published|draft> <destination> [tag] [--install-page]');
  }
  if (tag) validateTag(tag);
  const release = selectRelease(await getReleases(), tag, names, { allowMissing: installPage });
  if (!release) {
    await rm(join(destination, shortcutName), { force: true });
    if (installPage) {
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, 'index.html'), shortcutInstallPage(false));
    }
    console.log(`No published v2 shortcut exists yet.`);
    return;
  }
  if (release.draft !== (mode === 'draft')) throw new Error(`Expected a ${mode} release.`);
  const temporary = await mkdtemp(join(tmpdir(), 'crate-release-shortcut-'));
  try {
    await downloadRelease(release.tag_name, names, temporary);
    const metadata = JSON.parse(await readFile(join(temporary, names.metadataName), 'utf8'));
    const bytes = await readFile(join(temporary, names.assetName));
    verifyShortcut(metadata, bytes, release.tag_name, mode === 'draft' ? await sourceHash() : undefined, names.assetName);
    await mkdir(destination, { recursive: true });
    await copyFile(join(temporary, names.assetName), join(destination, shortcutName));
    if (installPage) await writeFile(join(destination, 'index.html'), shortcutInstallPage(true));
    console.log(`Verified shortcut from ${release.tag_name}: ${metadata.sha256}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) await downloadShortcut(process.argv.slice(2));
