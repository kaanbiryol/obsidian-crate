import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const workflowPath = '.github/workflows/lint.yml';
const api = path => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' }));
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
	if (extra.length || !['select', 'check'].includes(mode) || (mode === 'select' && id) || (mode === 'check' && !id)) {
		throw new Error('Usage: node scripts/release-verification.mjs select | check <run-id>');
	}
	const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
	if (mode === 'select') {
		const run = await findVerifiedRun(commit);
		if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'run-id=' + (run?.id ?? '') + '\n');
		console.log(run ? 'Reusing verification: ' + run.html_url : 'No reusable push build; running complete verification.');
	} else {
		const run = await checkVerifiedRun(id, commit);
		console.log('Verified push build: ' + run.html_url);
	}
}
