import { execFileSync } from 'node:child_process';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { gh, releases, shortcutName, assetName, metadataName, sha256, sourceHash, validateTag, verifyShortcut } from './shortcut-release.mjs';

const [tag, ...extra] = process.argv.slice(2);
validateTag(tag);
if (extra.length) throw new Error('Usage: npm run release:prepare -- <version>');
if (process.platform !== 'darwin') throw new Error('Prepare releases on your Mac signed into iCloud.');
const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim();
if (git(['status', '--porcelain'])) throw new Error('Commit or set aside working-tree changes before preparing a release.');
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
if (manifest.version !== tag) throw new Error('Version must exactly match manifest.json.');
const commit = git(['rev-parse', 'HEAD']);
if (gh(['api', `repos/{owner}/{repo}/commits/${tag}`, '--jq', '.sha']) !== commit) {
  throw new Error('Push the release tag first and check out its exact commit before signing.');
}
const existing = releases().find(item => item.tag_name === tag);
if (existing && !existing.draft) throw new Error('Refusing to change a published release.');
const sourceSha256 = await sourceHash();
execFileSync(process.execPath, ['--test', 'scripts/reading-shortcut.test.mjs'], { stdio: 'inherit' });
execFileSync(process.execPath, ['scripts/sign-reading-shortcut.mjs', '--pairing'], { stdio: 'inherit' });
const bytes = await readFile(`dist/${shortcutName}`);
const metadata = { format: 1, tag, file: assetName, sha256: sha256(bytes), sourceSha256 };
verifyShortcut(metadata, bytes, tag, await sourceHash());
await copyFile(`dist/${shortcutName}`, `dist/${assetName}`);
await writeFile(`dist/${metadataName}`, `${JSON.stringify(metadata, null, 2)}\n`);
if (!existing) gh(['release', 'create', tag, '--draft', '--generate-notes', '--verify-tag', '--title', tag]);
// Recheck before replacing assets, including when resuming a failed preparation.
if (gh(['release', 'view', tag, '--json', 'isDraft', '--jq', '.isDraft']) !== 'true') throw new Error('Release is no longer a draft.');
gh(['release', 'upload', tag, `dist/${assetName}`, `dist/${metadataName}`, '--clobber']);
// Explicit dispatch runs after upload, avoiding a tag-trigger race with signing.
gh(['workflow', 'run', 'release.yml', '--ref', tag, '-f', `tag=${tag}`]);
console.log(`Shortcut uploaded to draft ${tag}; release verification dispatched. Keep the release in draft until CI and device acceptance pass.`);
