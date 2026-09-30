import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { assetName, metadataName, shortcutName, sha256, sourceHash, verifyShortcut } from './shortcut-release.mjs';
import { findVerifiedRun } from './release-verification.mjs';

const versionFiles = ['package.json', 'package-lock.json', 'manifest.json', 'versions.json'];
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function releaseVersion(target, current) {
	if (!stableVersion.test(current)) throw new Error('The current manifest must have an x.y.z version.');
	const parts = current.split('.').map(Number);
	if (['patch', 'minor', 'major'].includes(target)) {
		const index = { major: 0, minor: 1, patch: 2 }[target];
		parts[index]++;
		for (let i = index + 1; i < parts.length; i++) parts[i] = 0;
		target = parts.join('.');
	}
	if (!stableVersion.test(target ?? '')) throw new Error('Choose patch, minor, major or an x.y.z version without a leading v.');
	const next = target.split('.').map(Number);
	if (!next.every(Number.isSafeInteger)) throw new Error('Release version numbers are too large.');
	const comparison = next.map((value, index) => value - current.split('.').map(Number)[index]).find(value => value !== 0) ?? 0;
	if (comparison < 0) throw new Error('Release versions cannot decrease.');
	return target;
}

export function prepareOptions(args) {
	const { positionals, values } = parseArgs({ args, allowPositionals: true, options: {
		'dry-run': { type: 'boolean' }, 'no-wait': { type: 'boolean' }, resign: { type: 'boolean' },
	} });
	if (positionals.length !== 1) throw new Error('Usage: npm run release:prepare -- <patch|minor|major|version> [--dry-run] [--no-wait] [--resign]');
	return { target: positionals[0], dryRun: values['dry-run'], noWait: values['no-wait'], resign: values.resign };
}

export async function prepareRelease({ target, dryRun = false, noWait = false, resign = false,
	root = process.cwd(), run = execFileSync, platform = process.platform, logger = console,
	pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) }) {
	const execute = (command, args, options = {}) => String(run(command, args, { cwd: root, encoding: 'utf8', ...options }) ?? '').trim();
	const git = (args, options) => execute('git', args, options);
	const head = git(['rev-parse', 'HEAD']);
	const current = JSON.parse(git(['show', head + ':manifest.json'])).version;
	// An explicit version can resume an existing tag even after HEAD advances.
	const tag = releaseVersion(target, stableVersion.test(target ?? '') ? target : current);
	if (!dryRun && platform !== 'darwin') throw new Error('Prepare signed releases on a Mac signed into iCloud.');
	let repository, existing, remoteCommit = '';
	if (!dryRun) {
		repository = execute('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
		const releases = JSON.parse(execute('gh', ['api', '--paginate', '--slurp', 'repos/' + repository + '/releases?per_page=100'])).flat();
		existing = releases.find(release => release.tag_name === tag);
		if (existing && !existing.draft) throw new Error('Refusing to change a published release.');
		const ref = 'refs/tags/' + tag;
		const refs = new Map(git(['ls-remote', '--tags', 'origin', ref, ref + '^{}']).split('\n').filter(Boolean).map(line => {
			const [sha, name] = line.split('\t'); return [name, sha];
		}));
		remoteCommit = refs.get(ref + '^{}') || refs.get(ref) || '';
		if (remoteCommit) git(['fetch', '--no-tags', 'origin', ref], { stdio: 'inherit' });
	}
	let localCommit = '';
	try { localCommit = git(['rev-parse', '--verify', '--quiet', 'refs/tags/' + tag + '^{commit}'], { stdio: ['ignore', 'pipe', 'pipe'] }); }
	catch (error) { if (error.status !== 1) throw error; }
	if (localCommit && remoteCommit && localCommit !== remoteCommit) throw new Error('Local and remote release tags differ; neither tag will be replaced.');
	if (!localCommit && !remoteCommit) releaseVersion(tag, current);
	const startingCommit = remoteCommit || localCommit || head;
	const temporary = await mkdtemp(join(tmpdir(), 'crate-release-'));
	const checkout = join(temporary, 'checkout');
	let added = false, complete = false;
	const inCheckout = { cwd: checkout };
	try {
		git(['worktree', 'add', '--detach', checkout, startingCommit], { stdio: 'inherit' });
		added = true;
		const manifest = JSON.parse(await readFile(join(checkout, 'manifest.json'), 'utf8'));
		if ((localCommit || remoteCommit) && manifest.version !== tag) throw new Error('The existing tag does not match its manifest version.');
		if (manifest.version !== tag) {
			execute('npm', ['version', tag, '--no-git-tag-version', '--ignore-scripts'], { ...inCheckout, stdio: 'inherit' });
			execute(process.execPath, ['version-bump.mjs'], { ...inCheckout, env: { ...process.env, npm_package_version: tag }, stdio: 'inherit' });
		}
		if (dryRun) {
			logger.log(git(['diff', '--', ...versionFiles], inCheckout));
			logger.log('Would prepare ' + tag + ' from committed source ' + startingCommit + ' on release/' + tag + '.');
			logger.log('Would sign the shortcut, push the version commit and tag, verify CI and prepare a draft.');
			complete = true;
			return { tag, commit: startingCommit, dryRun: true };
		}
		if (manifest.version !== tag) {
			git(['add', '--', ...versionFiles], inCheckout);
			git(['commit', '-m', 'chore: release ' + tag], { ...inCheckout, stdio: 'inherit' });
		}
		const commit = git(['rev-parse', 'HEAD'], inCheckout);
		const env = { ...process.env, GH_REPO: repository };
		const gh = args => execute('gh', args, { ...inCheckout, env });
		const request = path => JSON.parse(gh(['api', path]));
		execute(process.execPath, ['--test', 'scripts/reading-shortcut.test.mjs'], { ...inCheckout, stdio: 'inherit' });
		const sourceSha256 = await sourceHash(checkout);
		if (!resign && existing?.assets?.some(asset => asset.name === assetName) && existing.assets.some(asset => asset.name === metadataName)) {
			// Reuse only the verified draft download for this tag and source. Files
			// left by earlier local signing attempts are never selected.
			execute(process.execPath, ['scripts/download-release-shortcut.mjs', 'draft', 'dist', tag], { ...inCheckout, env, stdio: 'inherit' });
		} else {
			execute(process.execPath, ['scripts/sign-reading-shortcut.mjs', '--pairing'], { ...inCheckout, stdio: 'inherit' });
		}
		const bytes = await readFile(join(checkout, 'dist', shortcutName));
		const metadata = { format: 1, tag, file: assetName, sha256: sha256(bytes), sourceSha256 };
		verifyShortcut(metadata, bytes, tag, await sourceHash(checkout));
		if (git(['status', '--porcelain'], inCheckout)) throw new Error('Release preparation changed committed source.');
		await mkdir(join(checkout, 'dist'), { recursive: true });
		await copyFile(join(checkout, 'dist', shortcutName), join(checkout, 'dist', assetName));
		await writeFile(join(checkout, 'dist', metadataName), JSON.stringify(metadata, null, 2) + '\n');
		if (!localCommit) git(['tag', tag, commit], inCheckout);
		if (!remoteCommit) {
			// Ordinary pushes refuse divergent branches and tags. Keep the local
			// tag on failures so retries resume the exact version commit.
			git(['push', 'origin', 'HEAD:refs/heads/release/' + tag], { ...inCheckout, stdio: 'inherit' });
			git(['push', 'origin', 'refs/tags/' + tag], { ...inCheckout, stdio: 'inherit' });
		}
		if (request('repos/' + repository + '/commits/' + tag).sha !== commit) throw new Error('The remote tag changed during release preparation.');
		if (!existing) gh(['release', 'create', tag, '--draft', '--generate-notes', '--verify-tag', '--title', tag]);
		if (gh(['release', 'view', tag, '--json', 'isDraft', '--jq', '.isDraft']) !== 'true') throw new Error('Release is no longer a draft.');
		gh(['release', 'upload', tag, 'dist/' + assetName, 'dist/' + metadataName, '--clobber']);
		const draftUrl = gh(['release', 'view', tag, '--json', 'url', '--jq', '.url']);
		logger.log('Draft: ' + draftUrl);
		const runs = workflow => request('repos/' + repository + '/actions/workflows/' + workflow + '/runs?head_sha=' + commit + '&per_page=100').workflow_runs;
		async function waitForRun(workflow, predicate) {
			for (let attempt = 0; attempt < 12; attempt++) {
				const found = runs(workflow).find(predicate);
				if (found) return found;
				await pause(5000);
			}
			throw new Error('Could not find ' + workflow + ' for ' + commit + '. Draft retained; retry preparation.');
		}
		const verified = await findVerifiedRun(commit, { repository, request });
		if (!verified) {
			const pushRun = !remoteCommit ? await waitForRun('lint.yml', item => item.event === 'push' && item.head_branch === 'release/' + tag)
				: runs('lint.yml').find(item => item.event === 'push' && item.status !== 'completed');
			if (pushRun) {
				logger.log('Waiting for push verification: ' + pushRun.html_url);
				execute('gh', ['run', 'watch', String(pushRun.id), '--exit-status', '--interval', '10'], { ...inCheckout, env, stdio: 'inherit' });
			}
		}
		const earlierRuns = new Set(runs('release.yml').map(item => item.id));
		gh(['workflow', 'run', 'release.yml', '--ref', tag, '-f', 'tag=' + tag]);
		const releaseRun = await waitForRun('release.yml', item => item.event === 'workflow_dispatch' && !earlierRuns.has(item.id));
		logger.log('Release verification: ' + releaseRun.html_url);
		if (!noWait) execute('gh', ['run', 'watch', String(releaseRun.id), '--exit-status', '--interval', '10'], { ...inCheckout, env, stdio: 'inherit' });
		logger.log(noWait ? 'Verification dispatched. Keep the release in draft until CI and device acceptance pass.'
			: 'CI passed. Complete device and hosted acceptance against the draft assets before publishing.');
		complete = true;
		return { tag, commit, draftUrl, runUrl: releaseRun.html_url };
	} catch (error) {
		if (added) logger.error('Release checkout retained for recovery: ' + checkout);
		throw error;
	} finally {
		if (complete && added) git(['worktree', 'remove', '--force', checkout], { stdio: 'inherit' });
		if (complete || !added) await rm(temporary, { recursive: true, force: true });
	}
}

if (import.meta.main) await prepareRelease(prepareOptions(process.argv.slice(2)));
