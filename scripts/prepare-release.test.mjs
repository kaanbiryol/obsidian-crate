import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { prepareOptions, prepareRelease, releaseVersion } from './prepare-release.mjs';
import { assetName, metadataName, shortcutName } from './shortcut-release.mjs';

test('version preparation accepts explicit stable versions and semantic bumps without backwards or flag-like tags', () => {
	assert.equal(releaseVersion('patch', '0.4.1'), '0.4.2');
	assert.equal(releaseVersion('minor', '0.4.1'), '0.5.0');
	assert.equal(releaseVersion('major', '0.4.1'), '1.0.0');
	assert.equal(releaseVersion('0.4.1', '0.4.1'), '0.4.1');
	for (const target of ['0.4.0', 'v0.4.2', '0.4.2-beta.1', '01.4.2', '../tag', '--clobber', '9007199254740992.0.0']) {
		assert.throws(() => releaseVersion(target, '0.4.1'));
	}
	assert.equal(prepareOptions(['patch', '--dry-run']).dryRun, true);
	assert.throws(() => prepareOptions(['patch', '--publish']));
	assert.throws(() => prepareOptions(['patch', 'extra']));
});

async function fixture(t, controls = {}) {
	const temporary = await mkdtemp(join(tmpdir(), 'crate-prepare-test-'));
	const root = join(temporary, 'repo'), remote = join(temporary, 'remote.git');
	await mkdir(root);
	const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	git(['init', '--initial-branch=main']);
	git(['config', 'user.email', 'release@example.invalid']);
	git(['config', 'user.name', 'Release test']);
	git(['config', 'commit.gpgsign', 'false']);
	git(['config', 'tag.gpgsign', 'false']);
	git(['init', '--bare', remote]);
	git(['remote', 'add', 'origin', remote]);
	const files = {
		'package.json': JSON.stringify({ name: 'release-fixture', version: '0.4.1' }),
		'package-lock.json': JSON.stringify({ name: 'release-fixture', version: '0.4.1', lockfileVersion: 3, packages: { '': { name: 'release-fixture', version: '0.4.1' } } }),
		'manifest.json': JSON.stringify({ version: '0.4.1', minAppVersion: '1.13.0', id: 'crate' }),
		'versions.json': JSON.stringify({ '0.4.1': '1.13.0' }), '.gitignore': 'dist/\n', 'unrelated.txt': 'committed source',
		'docs/shortcuts/save-to-crate.plist': 'template', 'src/reading/shortcut-contract.json': '{}',
		'scripts/reading-shortcut-template.mjs': '', 'scripts/reading-shortcut-first-run.mjs': '', 'scripts/sign-reading-shortcut.mjs': '',
	};
	for (const [path, text] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text);
	}
	await copyFile(new URL('../version-bump.mjs', import.meta.url), join(root, 'version-bump.mjs'));
	git(['add', '.']); git(['commit', '-m', 'feat: initial source']);
	git(['push', 'origin', 'main']);
	await writeFile(join(root, 'unrelated.txt'), 'staged user work'); git(['add', 'unrelated.txt']);
	await writeFile(join(root, 'unrelated.txt'), 'unstaged user work');
	const before = { head: git(['rev-parse', 'HEAD']), status: git(['status', '--porcelain']), staged: git(['diff', '--cached']), unstaged: git(['diff']) };
	const calls = [], logs = [];
	let releaseRunId = 19, pushWatched = false, draft = controls.published ? { tag_name: '0.4.2', draft: false } : undefined;
	let checkout;
	const repository = 'example/crate';
	const pushRun = sha => ({ id: 10, run_attempt: 1, head_sha: sha, event: 'push', head_branch: 'release/0.4.2', path: '.github/workflows/lint.yml',
		repository: { full_name: repository }, head_repository: { full_name: repository }, status: pushWatched ? 'completed' : 'in_progress', conclusion: pushWatched ? 'success' : null, html_url: 'https://example.invalid/build/10' });
	const run = (command, args, options) => {
		calls.push({ command, args });
		if (command === 'git' && args[0] === 'worktree' && args[1] === 'add') checkout = args[3];
		if (command === process.execPath && args[0] === '--test') return '';
		if (command === process.execPath && ['scripts/sign-reading-shortcut.mjs', 'scripts/download-release-shortcut.mjs'].includes(args[0])) {
			if (controls.signingFailure) throw new Error('Apple signing failed');
			mkdirSync(join(options.cwd, 'dist'), { recursive: true });
			writeFileSync(join(options.cwd, 'dist', shortcutName), 'AEA1signed fixture'); return '';
		}
		if (command !== 'gh') return execFileSync(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
		if (args[0] === 'repo') return repository;
		if (args[0] === 'api') {
			if (args.includes('--slurp')) return JSON.stringify([draft ? [draft] : []]);
			const path = args[1];
			if (path.includes('/commits/')) return JSON.stringify({ sha: git(['rev-parse', 'refs/tags/0.4.2']) });
			if (path.includes('/workflows/lint.yml/')) {
				const sha = new URL('https://example.invalid/' + path).searchParams.get('head_sha');
				return JSON.stringify({ workflow_runs: path.includes('status=success') && !pushWatched ? [] : [pushRun(sha)] });
			}
			if (path.includes('/workflows/release.yml/')) return JSON.stringify({ workflow_runs: releaseRunId >= 20 ? [{ id: releaseRunId, event: 'workflow_dispatch', html_url: 'https://example.invalid/release/' + releaseRunId }] : [] });
			if (path.includes('/artifacts')) return JSON.stringify({ artifacts: [{ name: 'release-assets', size_in_bytes: 100, expired: false }] });
		}
		if (args[0] === 'release') {
			if (args[1] === 'create') { draft = { tag_name: '0.4.2', draft: true, assets: [] }; return ''; }
			if (args[1] === 'view') return args.includes('isDraft') ? 'true' : 'https://example.invalid/draft/0.4.2';
			if (args[1] === 'upload') {
				for (const name of [assetName, metadataName]) assert.ok(existsSync(join(options.cwd, 'dist', name)));
				draft.assets = [{ name: assetName }, { name: metadataName }]; return '';
			}
		}
		if (args[0] === 'workflow') { releaseRunId++; return ''; }
		if (args[0] === 'run' && args[1] === 'watch') {
			if (args[2] === '10') { if (controls.verificationFailure) throw new Error('Push verification failed'); pushWatched = true; }
			return '';
		}
		throw new Error('Unexpected GitHub operation: ' + args.join(' '));
	};
	t.after(async () => {
		if (checkout && existsSync(checkout)) {
			git(['worktree', 'remove', '--force', checkout]); await rm(dirname(checkout), { recursive: true, force: true });
		}
		await rm(temporary, { recursive: true, force: true });
	});
	return { root, git, before, calls, logs, options: { target: 'patch', root, run, platform: 'darwin', pause: async () => {}, logger: { log: text => logs.push(text), error: text => logs.push(text) } }, checkout: () => checkout };
}

function unchanged(f) {
	assert.equal(f.git(['rev-parse', 'HEAD']), f.before.head);
	assert.equal(f.git(['status', '--porcelain']), f.before.status);
	assert.equal(f.git(['diff', '--cached']), f.before.staged);
	assert.equal(f.git(['diff']), f.before.unstaged);
}

test('dry run prepares version files in isolation and never signs, commits, tags or calls GitHub', async t => {
	const f = await fixture(t);
	assert.equal((await prepareRelease({ ...f.options, dryRun: true })).tag, '0.4.2');
	unchanged(f);
	assert.ok(!f.calls.some(call => call.command === 'gh'));
	assert.ok(!f.calls.some(call => call.command === 'git' && ['commit', 'tag', 'push'].includes(call.args[0])));
	assert.ok(!existsSync(f.checkout()));
});

test('one command pushes only the version commit, waits for CI, prepares a draft and preserves dirty user work', async t => {
	const f = await fixture(t);
	const result = await prepareRelease(f.options);
	unchanged(f);
	assert.equal(result.tag, '0.4.2');
	assert.deepEqual(f.git(['diff-tree', '--no-commit-id', '--name-only', '-r', result.commit]).split('\n').sort(), ['manifest.json', 'package-lock.json', 'package.json', 'versions.json']);
	assert.equal(f.git(['show', result.commit + ':unrelated.txt']), 'committed source');
	assert.equal(f.git(['log', '-1', '--format=%B', result.commit]), 'chore: release 0.4.2');
	const watches = f.calls.filter(call => call.command === 'gh' && call.args[0] === 'run');
	assert.deepEqual(watches.map(call => call.args[2]), ['10', '20']);
	assert.ok(f.calls.find(call => call.command === 'gh' && call.args[1] === 'create').args.includes('--draft'));
	assert.ok(!f.calls.some(call => call.args.includes('--force') && call.args[0] === 'push'));
	assert.ok(!f.calls.some(call => call.command === 'gh' && call.args.includes('--draft=false')));
	assert.ok(!existsSync(f.checkout()));
	// A retry downloads the source-verified shortcut and reuses the same commit.
	const firstCalls = f.calls.length;
	const retry = await prepareRelease({ ...f.options, target: '0.4.2', noWait: true });
	assert.equal(retry.commit, result.commit);
	assert.ok(f.calls.slice(firstCalls).some(call => call.args[0] === 'scripts/download-release-shortcut.mjs'));
	assert.ok(!f.calls.slice(firstCalls).some(call => call.args[0] === 'scripts/sign-reading-shortcut.mjs'));
	unchanged(f);
});

test('signing failure cannot upload stale local bytes, push a tag or dispatch verification', async t => {
	const f = await fixture(t, { signingFailure: true });
	await assert.rejects(prepareRelease(f.options), /Apple signing failed/);
	unchanged(f);
	assert.ok(!f.calls.some(call => call.command === 'gh' && ['release', 'workflow'].includes(call.args[0])));
	assert.ok(!f.calls.some(call => call.command === 'git' && ['push', 'tag'].includes(call.args[0])));
	assert.ok(existsSync(f.checkout()));
});

test('an explicit existing tag resumes its original source after the development version advances', async t => {
	const f = await fixture(t);
	const original = await prepareRelease(f.options);
	execFileSync('npm', ['version', '0.5.0', '--no-git-tag-version', '--ignore-scripts'], { cwd: f.root, stdio: 'pipe' });
	await writeFile(join(f.root, 'manifest.json'), JSON.stringify({ version: '0.5.0', minAppVersion: '1.13.0', id: 'crate' }));
	f.git(['commit', '--only', '-m', 'chore: advance development version', '--', 'package.json', 'package-lock.json', 'manifest.json']);
	f.before.head = f.git(['rev-parse', 'HEAD']);
	f.before.status = f.git(['status', '--porcelain']);
	f.before.staged = f.git(['diff', '--cached']);
	f.before.unstaged = f.git(['diff']);
	const result = await prepareRelease({ ...f.options, target: '0.4.2', noWait: true });
	assert.equal(result.commit, original.commit);
	unchanged(f);
	await assert.rejects(prepareRelease({ ...f.options, target: '0.4.3' }), /cannot decrease/);
});

test('failed push verification keeps a recoverable draft and never starts release attachment', async t => {
	const f = await fixture(t, { verificationFailure: true });
	await assert.rejects(prepareRelease(f.options), /Push verification failed/);
	unchanged(f);
	assert.ok(f.calls.some(call => call.command === 'gh' && call.args[1] === 'upload'));
	assert.ok(!f.calls.some(call => call.command === 'gh' && call.args[0] === 'workflow'));
	assert.ok(existsSync(f.checkout()));
});

test('published releases are rejected before checkout, signing or remote writes', async t => {
	const f = await fixture(t, { published: true });
	await assert.rejects(prepareRelease(f.options), /published release/);
	unchanged(f);
	assert.ok(!f.checkout());
	assert.ok(!f.calls.some(call => call.command === 'gh' && call.args[0] === 'release'));
});
