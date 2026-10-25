import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

const workflowPath = '.github/workflows/lint.yml';
const api = path => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' }));
const localGit = args => execFileSync('git', args, { encoding: 'utf8' }).trim();
const versionFiles = ['manifest.json', 'package.json', 'package-lock.json', 'versions.json'];
const repositoryName = () => process.env.GH_REPO || execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { encoding: 'utf8' }).trim();

export function assertVerifiedRun(run, commit, repository) {
	if (!/^[a-f0-9]{40}$/.test(commit)
		|| run.head_sha !== commit || run.path !== workflowPath || run.event !== 'push'
		|| run.repository?.full_name !== repository || run.head_repository?.full_name !== repository
		|| run.status !== 'completed' || run.conclusion !== 'success'
		|| !Number.isSafeInteger(run.id) || run.id <= 0
		|| !Number.isSafeInteger(run.run_attempt) || run.run_attempt <= 0) {
		throw new Error('Release reuse requires a successful repository push build for the exact commit.');
	}
	return run;
}

function releaseArtifact(artifacts) {
	const matches = artifacts.filter(artifact => artifact.name === 'release-assets');
	return matches.length === 1 && !matches[0].expired && matches[0].size_in_bytes > 0 ? matches[0] : undefined;
}

export async function findVerifiedRun(commit, { repository = repositoryName(), request = api } = {}) {
	if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Expected a full release commit SHA.');
	const response = await request('repos/' + repository + '/actions/workflows/lint.yml/runs?event=push&status=success&head_sha=' + commit + '&per_page=100');
	for (const run of response.workflow_runs) {
		try { assertVerifiedRun(run, commit, repository); }
		catch { continue; }
		const { artifacts } = await request('repos/' + repository + '/actions/runs/' + run.id + '/artifacts?per_page=100');
		if (releaseArtifact(artifacts)) return run;
	}
	return undefined;
}

export async function checkVerifiedRun(id, commit, { repository = repositoryName(), request = api } = {}) {
	if (!/^[1-9]\d*$/.test(String(id))) throw new Error('Expected a verification run ID.');
	const run = assertVerifiedRun(await request('repos/' + repository + '/actions/runs/' + id), commit, repository);
	const { artifacts } = await request('repos/' + repository + '/actions/runs/' + id + '/artifacts?per_page=100');
	if (!releaseArtifact(artifacts)) throw new Error('Verified release assets are missing, ambiguous or expired.');
	return run;
}

// A release commit may reuse its parent's push build only when it changes the
// version and nothing else. Source checks and the reproducible rebuild still run on it.
export function assertVersionOnlyChange(parent, child) {
	const fail = () => { throw new Error('Parent verification requires a commit that only changes the release version.'); };
	const read = (files, path) => { try { return JSON.parse(files[path]); } catch { return fail(); } };
	const [manifest, parentManifest] = [read(child, 'manifest.json'), read(parent, 'manifest.json')];
	const version = manifest.version;
	if (typeof version !== 'string' || !version) fail();
	const withoutVersion = (value, lock) => {
		const copy = structuredClone(value);
		delete copy.version;
		if (lock && copy.packages?.['']) delete copy.packages[''].version;
		return copy;
	};
	for (const [path, lock] of [['manifest.json', false], ['package.json', false], ['package-lock.json', true]]) {
		const [before, after] = [read(parent, path), read(child, path)];
		if (after.version !== version || (lock && after.packages?.['']?.version !== version)
			|| !isDeepStrictEqual(withoutVersion(before, lock), withoutVersion(after, lock))) fail();
	}
	const [versions, parentVersions] = [read(child, 'versions.json'), read(parent, 'versions.json')];
	if (versions[version] !== parentManifest.minAppVersion
		|| !isDeepStrictEqual({ ...parentVersions, [version]: versions[version] }, versions)) fail();
}

export function versionOnlyParent(commit, git = localGit) {
	if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Expected a full release commit SHA.');
	const [, parent, ...others] = git(['rev-list', '--parents', '-n', '1', commit]).split(' ');
	if (!/^[a-f0-9]{40}$/.test(parent ?? '') || others.length) {
		throw new Error('Parent verification requires a commit that only changes the release version.');
	}
	const changed = git(['diff', '--name-only', '--no-renames', parent, commit]).split('\n').filter(Boolean);
	if (!changed.length || changed.some(path => !versionFiles.includes(path))) {
		throw new Error('Parent verification requires a commit that only changes the release version.');
	}
	const files = sha => Object.fromEntries(versionFiles.map(path => [path, git(['show', sha + ':' + path])]));
	assertVersionOnlyChange(files(parent), files(commit));
	return parent;
}

export async function findVerifiedParentRun(commit, { repository = repositoryName(), request = api, git = localGit } = {}) {
	let parent;
	try { parent = versionOnlyParent(commit, git); }
	catch { return undefined; }
	const response = await request('repos/' + repository + '/actions/workflows/lint.yml/runs?event=push&status=success&head_sha=' + parent + '&per_page=100');
	return response.workflow_runs.find(run => {
		try { return assertVerifiedRun(run, parent, repository); }
		catch { return false; }
	});
}

export async function checkVerifiedParentRun(id, commit, { repository = repositoryName(), request = api, git = localGit } = {}) {
	if (!/^[1-9]\d*$/.test(String(id))) throw new Error('Expected a verification run ID.');
	const parent = versionOnlyParent(commit, git);
	return assertVerifiedRun(await request('repos/' + repository + '/actions/runs/' + id), parent, repository);
}

export function assertCandidate(candidate, { commit, repository, runId }) {
	if (!/^[a-f0-9]{40}$/.test(commit) || !repository || !/^[1-9]\d*$/.test(String(runId))
		|| candidate.format !== 1 || candidate.commit !== commit || candidate.dirty !== false
		|| candidate.verification?.format !== 1 || candidate.verification.repository !== repository
		|| !Number.isSafeInteger(candidate.verification.runId) || candidate.verification.runId <= 0
		|| String(candidate.verification.runId) !== String(runId)
		|| !Number.isSafeInteger(candidate.verification.runAttempt) || candidate.verification.runAttempt <= 0) {
		throw new Error('Release candidate does not belong to the verified commit and workflow run.');
	}
}

if (import.meta.main) {
	const [mode, id, ...extra] = process.argv.slice(2);
	if (extra.length || !['select', 'check', 'check-parent'].includes(mode) || (mode === 'select' && id) || (mode !== 'select' && !id)) {
		throw new Error('Usage: node scripts/release-verification.mjs select | check <run-id> | check-parent <run-id>');
	}
	const commit = localGit(['rev-parse', 'HEAD']);
	if (mode === 'select') {
		const run = await findVerifiedRun(commit);
		const parentRun = run ? undefined : await findVerifiedParentRun(commit);
		if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'run-id=' + (run?.id ?? '') + '\nparent-run-id=' + (parentRun?.id ?? '') + '\n');
		console.log(run ? 'Reusing verification: ' + run.html_url
			: parentRun ? 'Reusing version-only parent verification: ' + parentRun.html_url
				: 'No reusable push build; running complete verification.');
	} else if (mode === 'check') {
		const run = await checkVerifiedRun(id, commit);
		console.log('Verified push build: ' + run.html_url);
	} else {
		const run = await checkVerifiedParentRun(id, commit);
		console.log('Verified version-only parent push build: ' + run.html_url);
	}
}
