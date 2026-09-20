import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const root = resolve(import.meta.dirname, '..');
const exec = promisify(execFile);

test('packed npx installation starts without repository files and preserves data across changing public URLs', { timeout: 180_000 }, async t => {
	const directory = await mkdtemp(join(tmpdir(), 'crate-npx-test-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const { stdout: packOutput } = await exec('npm', ['pack', join(root, 'dist/server'), '--pack-destination', directory, '--json'], { cwd: directory });
	const [packed] = JSON.parse(packOutput);
	const paths = packed.files.map(file => file.path);
	assert.ok(paths.includes('assets/worker.mjs'));
	assert.ok(paths.includes('vendor/miniflare/LICENSE'));
	assert.ok(!paths.some(path => /node_modules\/.*(workerd|sharp)/.test(path)));
	assert.ok(paths.includes('npm-shrinkwrap.json'));
	assert.ok(!paths.some(path => path.includes('.test.') || path.includes('node_modules') || path.includes('.remote/') || path.includes('build-worker')));
	const tarball = join(directory, packed.filename);
	const cache = join(directory, 'cache');
	const { stdout: help } = await exec('npx', ['--yes', '--cache', cache, '--package', tarball, 'crate-server', '--help'], { cwd: directory, maxBuffer: 1024 * 1024 });
	assert.match(help, /Quick Tunnel/);
	const [cacheKey] = await readdir(join(cache, '_npx'));
	const install = join(cache, '_npx', cacheKey, 'node_modules', '@kaanbiryol', 'crate-server');
	const cli = join(install, 'scripts/crate-server.mjs');
	const miniflareRequire = createRequire(join(install, 'vendor/miniflare/dist/src/index.js'));
	assert.equal(miniflareRequire('sharp').versions.sharp, '0.35.4');
	await assert.rejects(stat(join(install, 'src')), { code: 'ENOENT' });
	const bin = join(directory, 'bin');
	await mkdir(bin);
	const countFile = join(directory, 'launch-count');
	const pidFile = join(directory, 'tunnel-pid');
	await writeFile(join(bin, 'cloudflared'), `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('test cloudflared'); process.exit(0); }
if (!process.argv.includes('--url')) process.exit(9);
let count = 0;
try { count = Number(readFileSync(${JSON.stringify(countFile)}, 'utf8')); } catch {}
writeFileSync(${JSON.stringify(countFile)}, String(++count));
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.stderr.write('https://crate-test-' + count + '.trycloudflare.com\\n');
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`, { mode: 0o755 });
	const dataDir = join(directory, 'data');
	let child;
	let exited;
	t.after(async () => { if (child?.exitCode === null) { child.kill('SIGTERM'); await exited; } });
	async function launch(args = []) {
		child = spawn(process.execPath, [cli, ...args, '--data-dir', dataDir], { cwd: directory,
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
		exited = once(child, 'exit');
		let output = '';
		let errors = '';
		child.stdout.on('data', chunk => { output += chunk; });
		child.stderr.on('data', chunk => { errors += chunk; });
		const deadline = Date.now() + 30_000;
		while (!output.includes('Press Ctrl+C')) {
			assert.equal(child.exitCode, null, `${errors}\n${output}`);
			assert.ok(Date.now() < deadline, `${errors}\n${output}`);
			await delay(50);
		}
		return { output, local: `http://127.0.0.1:${/Internal listener \(diagnostics only\): 127.0.0.1:(\d+)/.exec(output)[1]}` };
	}
	async function stop() {
		child.kill('SIGTERM');
		assert.equal((await exited)[0], 0);
		const pid = Number(await readFile(pidFile, 'utf8'));
		assert.throws(() => process.kill(pid, 0), /ESRCH/);
		await assert.rejects(stat(join(dataDir, 'server.lock')), { code: 'ENOENT' });
	}
	const first = await launch();
	assert.match(first.output, /https:\/\/crate-test-1.trycloudflare.com/);
	const code = /crate-pair-[a-f0-9]{64}/.exec(first.output)?.[0];
	assert.ok(code);
	assert.ok(!first.output.includes('Access token (shown once)'));
	const exchange = await fetch(`${first.local}/__crate/pair`, { method: 'POST', body: JSON.stringify({ code }) });
	assert.equal(exchange.status, 200);
	const { authToken: token } = await exchange.json();
	let response = await fetch(`${first.local}/health`, { headers: { Authorization: `Bearer ${token}` } });
	assert.equal(response.status, 200);
	await response.text();
	response = await fetch(`${first.local}/notifications`);
	assert.equal(response.status, 200);
	await response.text();
	const metadata = await readFile(join(dataDir, 'server.json'), 'utf8');
	await stop();
	const second = await launch(['start']);
	assert.match(second.output, /https:\/\/crate-test-2.trycloudflare.com/);
	assert.ok(!second.output.includes(token));
	assert.ok(!second.output.includes('Access token (shown once)'));
	assert.equal(await readFile(join(dataDir, 'server.json'), 'utf8'), metadata);
	response = await fetch(`${second.local}/health`, { headers: { Authorization: `Bearer ${token}` } });
	assert.equal(response.status, 200);
	await response.text();
	await stop();
});
