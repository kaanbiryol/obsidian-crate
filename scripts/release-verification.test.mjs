import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { assertCandidate, assertVerifiedRun, assertVersionOnlyChange, checkVerifiedParentRun, checkVerifiedRun, findVerifiedParentRun, findVerifiedRun, versionOnlyParent } from './release-verification.mjs';
import { verifyReleaseAssets } from './release-artifacts.mjs';

const commit = 'a'.repeat(40), repository = 'example/crate';
const run = (id = 10, overrides = {}) => ({ id, run_attempt: 1, head_sha: commit, event: 'push', path: '.github/workflows/lint.yml',
	repository: { full_name: repository }, head_repository: { full_name: repository }, status: 'completed', conclusion: 'success', ...overrides });
const artifact = { name: 'release-assets', expired: false, size_in_bytes: 100 };
const candidate = () => ({ format: 1, commit, dirty: false, verification: { format: 1, repository, runId: 10, runAttempt: 1 } });
const identity = { commit, repository, runId: 10 };

test('reuse rejects different commits, forks, PRs, incomplete runs and other workflows', () => {
	assertVerifiedRun(run(), commit, repository);
	for (const change of [{ head_sha: 'b'.repeat(40) }, { head_repository: { full_name: 'fork/crate' } },
		{ repository: { full_name: 'another/crate' } }, { event: 'pull_request' }, { event: 'workflow_dispatch' },
		{ path: '.github/workflows/visual.yml' }, { status: 'in_progress' }, { conclusion: 'failure' },
		{ conclusion: 'cancelled' }, { id: 0 }, { run_attempt: 0 }]) {
		assert.throws(() => assertVerifiedRun(run(10, change), commit, repository), /exact commit/);
	}
});

test('selection ignores unavailable artifacts and never considers artifacts from an untrusted run', async () => {
	const calls = [];
	const request = path => {
		calls.push(path);
		if (path.includes('/workflows/')) return { workflow_runs: [run(1, { event: 'pull_request' }), run(2), run(3), run(4), run(5)] };
		const id = Number(/runs\/(\d+)\//.exec(path)[1]);
		return { artifacts: { 2: [{ ...artifact, expired: true }], 3: [], 4: [artifact, artifact], 5: [artifact] }[id] };
	};
	assert.equal((await findVerifiedRun(commit, { repository, request })).id, 5);
	assert.ok(!calls.some(path => path.includes('/runs/1/')));
	assert.equal(await findVerifiedRun(commit, { repository, request: () => ({ workflow_runs: [] }) }), undefined);
	await assert.rejects(findVerifiedRun('--flag', { repository, request }), /full release commit/);
});

test('a selected run is rechecked and cannot be reused after cancellation, rerun or artifact expiry', async () => {
	const request = path => path.endsWith('/10') ? run() : { artifacts: [artifact] };
	assert.equal((await checkVerifiedRun(10, commit, { repository, request })).id, 10);
	await assert.rejects(checkVerifiedRun(10, commit, { repository, request: () => run(10, { status: 'in_progress' }) }), /exact commit/);
	await assert.rejects(checkVerifiedRun(10, commit, { repository, request: path => path.endsWith('/10') ? run() : { artifacts: [{ ...artifact, expired: true }] } }), /expired/);
});

const parent = 'b'.repeat(40);
const versionFiles = version => ({
	'manifest.json': JSON.stringify({ id: 'crate', version, minAppVersion: '1.13.0' }),
	'package.json': JSON.stringify({ name: 'crate', version, dependencies: { yaml: '2.0.0' } }),
	'package-lock.json': JSON.stringify({ name: 'crate', version, packages: { '': { version, dependencies: { yaml: '2.0.0' } }, 'node_modules/yaml': { version: '2.0.0' } } }),
	'versions.json': JSON.stringify(version === '0.4.1' ? { '0.4.1': '1.13.0' } : { '0.4.1': '1.13.0', [version]: '1.13.0' }),
});
const edit = (files, path, change) => ({ ...files, [path]: JSON.stringify(change(JSON.parse(files[path]))) });

test('parent reuse accepts a release version bump and nothing else', () => {
	assertVersionOnlyChange(versionFiles('0.4.1'), versionFiles('0.4.2'));
	const bumped = versionFiles('0.4.2');
	for (const change of [
		edit(bumped, 'package.json', value => ({ ...value, dependencies: { yaml: '9.9.9' } })),
		edit(bumped, 'package-lock.json', value => ({ ...value, packages: { ...value.packages, 'node_modules/yaml': { version: '9.9.9' } } })),
		edit(bumped, 'package-lock.json', value => ({ ...value, packages: { ...value.packages, '': { ...value.packages[''], version: '0.4.1' } } })),
		edit(bumped, 'manifest.json', value => ({ ...value, minAppVersion: '1.14.0' })),
		edit(bumped, 'package.json', value => ({ ...value, version: '0.4.3' })),
		edit(bumped, 'versions.json', value => ({ ...value, '0.4.1': '1.12.0' })),
		edit(bumped, 'versions.json', value => ({ ...value, '0.4.2': '1.14.0' })),
		{ ...bumped, 'manifest.json': 'not json' },
	]) {
		assert.throws(() => assertVersionOnlyChange(versionFiles('0.4.1'), change), /only changes the release version/);
	}
});

function fakeGit({ parents = [parent], changed = ['manifest.json', 'package.json', 'package-lock.json', 'versions.json'], child = versionFiles('0.4.2') } = {}) {
	return args => {
		if (args[0] === 'rev-list') return [commit, ...parents].join(' ');
		if (args[0] === 'diff') return changed.join('\n');
		if (args[0] === 'show') {
			const [sha, path] = args[1].split(':');
			return (sha === parent ? versionFiles('0.4.1') : child)[path];
		}
		throw new Error('Unexpected git call: ' + args.join(' '));
	};
}

test('parent reuse rejects merges, root commits and commits that change other files', () => {
	assert.equal(versionOnlyParent(commit, fakeGit()), parent);
	for (const git of [fakeGit({ parents: [] }), fakeGit({ parents: [parent, 'c'.repeat(40)] }), fakeGit({ changed: [] }),
		fakeGit({ changed: ['manifest.json', 'src/main.ts'] }), fakeGit({ child: edit(versionFiles('0.4.2'), 'package.json', value => ({ ...value, scripts: { build: 'x' } })) })]) {
		assert.throws(() => versionOnlyParent(commit, git), /only changes the release version/);
	}
});

test('parent reuse selects a trusted push build of the parent without needing its artifacts', async () => {
	const paths = [];
	const request = path => {
		paths.push(path);
		return { workflow_runs: [run(1, { head_sha: parent, event: 'pull_request' }), run(2, { head_sha: commit }), run(3, { head_sha: parent })] };
	};
	assert.equal((await findVerifiedParentRun(commit, { repository, request, git: fakeGit() })).id, 3);
	assert.ok(paths.every(path => path.includes('head_sha=' + parent) && !path.includes('/artifacts')));
	assert.equal(await findVerifiedParentRun(commit, { repository, request, git: fakeGit({ changed: ['src/main.ts'] }) }), undefined);
	assert.equal(paths.length, 1);
	assert.equal((await checkVerifiedParentRun(3, commit, { repository, request: () => run(3, { head_sha: parent }), git: fakeGit() })).id, 3);
	await assert.rejects(checkVerifiedParentRun(3, commit, { repository, request: () => run(3, { head_sha: parent, conclusion: 'cancelled' }), git: fakeGit() }), /exact commit/);
	await assert.rejects(checkVerifiedParentRun(3, commit, { repository, request: () => run(3, { head_sha: commit }), git: fakeGit() }), /exact commit/);
	await assert.rejects(checkVerifiedParentRun(3, commit, { repository, request: () => run(3, { head_sha: parent }), git: fakeGit({ changed: ['src/main.ts'] }) }), /only changes/);
});

test('candidate proof rejects dirty, foreign, stale and legacy artifacts', () => {
	assertCandidate(candidate(), identity);
	for (const change of [{ dirty: true }, { commit: 'b'.repeat(40) }, { format: 2 }, { verification: undefined },
		{ verification: { ...candidate().verification, runId: 20 } }, { verification: { ...candidate().verification, repository: 'fork/crate' } },
		{ verification: { ...candidate().verification, runAttempt: 0 } }]) {
		assert.throws(() => assertCandidate({ ...candidate(), ...change }, identity), /verified commit/);
	}
	assert.throws(() => assertCandidate(candidate(), { ...identity, runId: undefined }), /verified commit/);
});

async function assetFixture(t) {
	const root = await mkdtemp(join(tmpdir(), 'crate-release-assets-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const directory = join(root, 'release');
	const sources = { 'dist/main.js': 'plugin bytes', 'dist/styles.css': 'css bytes',
		'manifest.json': JSON.stringify({ version: '0.4.2', id: 'crate' }), 'THIRD_PARTY_NOTICES.md': 'notices',
		'.generated/cloudflare/worker.mjs': 'worker bytes', '.generated/cloudflare/pwa-client.json': 'pwa bytes', 'src/cloudflare/schema.sql': 'schema' };
	const record = { ...candidate(), version: '0.4.2', node: process.version, artifacts: {} };
	await mkdir(directory);
	await writeFile(join(root, '.nvmrc'), process.version.slice(1));
	for (const [path, text] of Object.entries(sources)) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), text);
		record.artifacts[path] = { sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) };
		if (!path.startsWith('.generated/') && !path.startsWith('src/')) await writeFile(join(directory, path.split('/').at(-1)), text);
	}
	await writeFile(join(directory, 'release-candidate.json'), JSON.stringify(record));
	return { root, directory, record, options: { ...identity, root } };
}

test('asset reuse verifies downloaded bytes and the current source and Worker before restoring anything', async t => {
	const { root, directory, options } = await assetFixture(t);
	await verifyReleaseAssets(directory, options);
	await writeFile(join(directory, 'main.js'), 'corrupted bytes');
	await assert.rejects(verifyReleaseAssets(directory, options), /checksum mismatch: dist\/main.js/);
	await writeFile(join(directory, 'main.js'), 'plugin bytes');
	await writeFile(join(root, '.generated/cloudflare/worker.mjs'), 'another build');
	await assert.rejects(verifyReleaseAssets(directory, options), /checksum mismatch.*worker/);
});

test('reproducibility compares a second build, including CSS, rather than downloaded checksums alone', async t => {
	const { root, directory, options } = await assetFixture(t);
	await verifyReleaseAssets(directory, { ...options, reproduce: true });
	await writeFile(join(root, 'dist/styles.css'), 'non-reproducible css');
	await assert.rejects(verifyReleaseAssets(directory, { ...options, reproduce: true }), /checksum mismatch: dist\/styles.css/);
});

test('candidate version, source metadata and pinned toolchain cannot drift', async t => {
	const { root, directory, record, options } = await assetFixture(t);
	await writeFile(join(root, 'manifest.json'), JSON.stringify({ version: '0.4.3', id: 'crate' }));
	await assert.rejects(verifyReleaseAssets(directory, options), /version or Node/);
	await writeFile(join(root, 'manifest.json'), JSON.stringify({ version: '0.4.2', id: 'changed' }));
	await assert.rejects(verifyReleaseAssets(directory, options), /checksum mismatch: manifest/);
	await writeFile(join(root, 'manifest.json'), JSON.stringify({ version: '0.4.2', id: 'crate' }));
	await writeFile(join(directory, 'release-candidate.json'), JSON.stringify({ ...record, node: 'v0.0.0' }));
	await assert.rejects(verifyReleaseAssets(directory, options), /version or Node/);
});

test('draft attachment depends on the complete verifier, with reproduction gated on the source artifacts', async () => {
	const release = parse(await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
	const verify = parse(await readFile(new URL('../.github/workflows/verify.yml', import.meta.url), 'utf8'));
	assert.deepEqual(release.jobs.publish.needs, ['resolve', 'verify']);
	assert.equal(release.jobs.verify.uses, './.github/workflows/verify.yml');
	assert.equal(verify.jobs.reproducible.needs, 'checks');
	assert.equal(verify.jobs.reproducible.if, "inputs.release-tag != ''");
	assert.ok(verify.jobs.reproducible.steps.some(step => step.run === 'node scripts/release-artifacts.mjs reproduce'));
	assert.ok(verify.jobs.checks.steps.some(step => step.run === 'npm run security:audit' && !step.if));
	assert.ok(verify.jobs.checks.steps.some(step => step.run === 'npm run security:secrets' && step.if === '${{ !cancelled() }}'));
	assert.ok(verify.jobs.checks.steps.some(step => step.run?.includes('npm run check:server-revision') && step.if === "inputs.reuse-run-id != ''"));
	// Version-only parent reuse skips test jobs, but the checks, staging and reproducible rebuild still run.
	for (const [name, job] of Object.entries(verify.jobs)) {
		if (['checks', 'reproducible'].includes(name)) assert.ok(!job.if?.includes('parent-run-id'), name);
		else assert.equal(job.if, "inputs.reuse-run-id == '' && inputs.parent-run-id == ''", name);
	}
	assert.ok(verify.jobs.checks.steps.some(step => step.run === 'node scripts/release-verification.mjs check-parent "$PARENT_RUN_ID"' && step.if === "inputs.parent-run-id != ''"));
	assert.ok(release.jobs.publish.steps.some(step => step.run === 'node scripts/release-verification.mjs check-parent "$PARENT_RUN_ID"'));
	assert.equal(release.jobs.verify.with['parent-run-id'], '${{ needs.resolve.outputs.parent-run-id }}');
	const build = parse(await readFile(new URL('../.github/workflows/lint.yml', import.meta.url), 'utf8'));
	assert.ok(build.on.workflow_dispatch.inputs['reuse-run-id']);
	assert.ok(build.on.workflow_dispatch.inputs['release-tag']);
	assert.equal(build.permissions.contents, 'read');
	assert.equal(build.jobs.verify.uses, './.github/workflows/verify.yml');
	// A pull request head runs once; release reuse needs push runs, which master and release/<tag> keep.
	assert.deepEqual(build.on.push, { branches: ['master', 'release/**'] });
	assert.equal(build.on.pull_request, null);
});

test('every hosted workflow job has a timeout', async () => {
	const directory = new URL('../.github/workflows/', import.meta.url);
	for (const name of await readdir(directory)) {
		const workflow = parse(await readFile(new URL(name, directory), 'utf8'));
		for (const [id, job] of Object.entries(workflow.jobs)) {
			// Reusable workflow calls take their jobs' own timeouts.
			if (job['runs-on']) assert.ok(Number.isInteger(job['timeout-minutes']), `${name} ${id}`);
		}
	}
});

test('CI mirrors check:source step by step and the local release gate runs the packed server test', async () => {
	const verify = parse(await readFile(new URL('../.github/workflows/verify.yml', import.meta.url), 'utf8'));
	const { scripts } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
	const commands = scripts['check:source'].split(' && ');
	const steps = verify.jobs.checks.steps.filter(step => commands.includes(step.run));
	assert.deepEqual(steps.map(step => step.run), commands);
	for (const step of steps) assert.equal(step.if, "${{ !cancelled() && inputs.reuse-run-id == '' }}", step.name);
	// The server revision check needs Git history and gh, so it runs beside check:source.
	assert.ok(verify.jobs.checks.steps.some(step => step.run === 'npm run check:server-revision' && step.if === "${{ !cancelled() && inputs.reuse-run-id == '' }}"));
	assert.ok(scripts['release:check'].split(' && ').includes('npm run check:server-revision'));
	assert.ok(verify.jobs.worker.steps.some(step => step.run === 'npm run test:server-package'));
	assert.ok(scripts['release:check'].split(' && ').includes('npm run test:server-package'));
});
