import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertCandidate } from './release-verification.mjs';

const files = { 'main.js': 'dist/main.js', 'styles.css': 'dist/styles.css', 'manifest.json': 'manifest.json', 'THIRD_PARTY_NOTICES.md': 'THIRD_PARTY_NOTICES.md' };
const generated = ['.generated/cloudflare/worker.mjs', '.generated/cloudflare/pwa-client.json', 'src/cloudflare/schema.sql'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function verifyReleaseAssets(directory, { root = process.cwd(), commit, repository, runId, reproduce = false }) {
	const candidate = JSON.parse(await readFile(resolve(directory, 'release-candidate.json'), 'utf8'));
	assertCandidate(candidate, { commit, repository, runId });
	const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
	const nodeVersion = (await readFile(resolve(root, '.nvmrc'), 'utf8')).trim();
	if (candidate.version !== manifest.version || candidate.node !== 'v' + nodeVersion || process.version !== candidate.node) {
		throw new Error('Release candidate version or Node.js toolchain differs from the checked-out source.');
	}
	async function verify(path, bytes) {
		const expected = candidate.artifacts[path];
		if (!expected || expected.sha256 !== digest(bytes) || expected.bytes !== bytes.byteLength) {
			throw new Error('Release artifact checksum mismatch: ' + path);
		}
	}
	for (const [name, path] of Object.entries(files)) {
		await verify(path, await readFile(resolve(directory, name)));
		// Source metadata must match the checkout; the second build must also
		// reproduce the plugin and CSS, rather than trusting the downloaded hashes.
		if (reproduce || !path.startsWith('dist/')) await verify(path, await readFile(resolve(root, path)));
	}
	for (const path of generated) await verify(path, await readFile(resolve(root, path)));
	return candidate;
}

if (import.meta.main) {
	const [mode, ...extra] = process.argv.slice(2);
	if (extra.length || !['stage', 'restore', 'reproduce'].includes(mode)) {
		throw new Error('Usage: node scripts/release-artifacts.mjs <stage|restore|reproduce>');
	}
	const directory = resolve('release');
	if (mode === 'stage') {
		await mkdir(directory, { recursive: true });
		for (const [name, path] of Object.entries(files)) await copyFile(path, resolve(directory, name));
		await copyFile('.generated/release-candidate.json', resolve(directory, 'release-candidate.json'));
	}
	const candidate = await verifyReleaseAssets(directory, {
		commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
		repository: process.env.GITHUB_REPOSITORY,
		runId: process.env.VERIFIED_RUN_ID || process.env.GITHUB_RUN_ID,
		reproduce: mode === 'reproduce',
	});
	if (mode === 'restore') {
		await mkdir('dist', { recursive: true });
		for (const name of ['main.js', 'styles.css']) await copyFile(resolve(directory, name), resolve('dist', name));
	}
	console.log('Release assets ' + mode + ': ' + candidate.version + ', commit ' + candidate.commit);
}
