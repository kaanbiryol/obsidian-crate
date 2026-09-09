import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const paths = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\0'))]
	.filter(path => /^(src\/|scripts\/|\.github\/|package(?:-lock)?\.json$|manifest\.json$|versions\.json$|wrangler\.jsonc$|(?:vite|vitest|tsconfig|eslint|playwright|knip)[^/]*$|\.nvmrc$)/.test(path)).sort();
const inputs = {};
for (const path of paths) {
	try { inputs[path] = digest(await readFile(path)); }
	catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const artifacts = {};
for (const path of ['dist/main.js', 'manifest.json', 'dist/styles.css', '.generated/cloudflare/worker.mjs', '.generated/cloudflare/pwa-client.json', 'src/cloudflare/schema.sql']) {
	const bytes = await readFile(path);
	artifacts[path] = { sha256: digest(bytes), bytes: bytes.byteLength };
}
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const record = {
	format: 1,
	createdAt: new Date().toISOString(),
	version: manifest.version,
	commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
	dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).length > 0,
	sourceSha256: digest(JSON.stringify(inputs)),
	node: process.version,
	npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
	artifacts,
	inputs,
	acceptance: { hostedOAuth: 'unverified', hostedPush: 'unverified', independentAccountRestore: 'unverified', physicalIOS: 'unverified', physicalAndroid: 'unverified' },
};
await mkdir('.generated', { recursive: true });
await writeFile('.generated/release-candidate.json', JSON.stringify(record, null, 2) + '\n');
console.log(`Candidate recorded: ${record.version}, source ${record.sourceSha256}, Node ${record.node}`);
