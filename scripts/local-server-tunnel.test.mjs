import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureCloudflared, normalizeTunnelHostname, readRemoteSettings, remotePaths, setupRemoteAccess } from './local-server-tunnel.mjs';
import { tunnelEnvironment } from './local-server-process.mjs';

const tunnelId = '11111111-1111-4111-8111-111111111111';
const credentials = { TunnelID: tunnelId, AccountTag: 'test-account', TunnelSecret: Buffer.alloc(32).toString('base64') };

test('public hostname validation rejects URLs, injection, wildcard, and local addresses', () => {
	assert.equal(normalizeTunnelHostname(' Crate.Example.com '), 'crate.example.com');
	for (const hostname of ['localhost', '127.0.0.1', '[::1]', 'a.local', 'a.localhost', 'https://a.example.com',
		'a.example.com/path', 'a.example.com:443', '*.example.com', 'a..example.com', '-x.example.com', 'a.example.com\nservice: foo']) {
		assert.throws(() => normalizeTunnelHostname(hostname));
	}
});

test('setup resumes a failed DNS route and reuses the tunnel without overwriting DNS', async t => {
	const directory = await mkdtemp(join(tmpdir(), 'crate-tunnel-setup-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const dataDir = join(directory, 'data');
	const paths = remotePaths(dataDir);
	const calls = [];
	let failDNS = true;
	const run = async (command, args, options) => {
		calls.push({ command, args });
		assert.ok(!Object.keys(options.env).some(key => key.startsWith('TUNNEL_')));
		if (args.includes('create')) await writeFile(paths.credentials, JSON.stringify(credentials));
		if (args.includes('dns') && failDNS) throw new Error('DNS name already exists');
	};
	const setup = () => setupRemoteAccess({ dataDir, hostname: 'crate.example.com', port: 8877, run });
	await assert.rejects(setup(), /DNS name already exists/);
	assert.equal((await readRemoteSettings(dataDir)).ready, false);
	assert.equal((await readRemoteSettings(dataDir)).tunnelId, tunnelId);
	failDNS = false;
	const settings = await setup();
	assert.equal(settings.ready, true);
	await setup();
	assert.equal(calls.filter(call => call.args.includes('create')).length, 1);
	assert.equal(calls.filter(call => call.args.includes('dns')).length, 2);
	assert.ok(calls.every(call => !call.args.includes('--overwrite-dns')));
	assert.deepEqual(JSON.parse(await readFile(paths.config, 'utf8')).ingress,
		[{ hostname: 'crate.example.com', service: 'http://127.0.0.1:8877' }, { service: 'http_status:404' }]);
	assert.equal((await stat(paths.settings)).mode & 0o777, 0o600);
	assert.equal((await stat(paths.credentials)).mode & 0o777, 0o600);
	assert.equal((await stat(paths.directory)).mode & 0o777, 0o700);
	await assert.rejects(setupRemoteAccess({ dataDir, hostname: 'new.example.com', run }), /already has/);
	await rm(paths.credentials);
	await assert.rejects(setup(), /credentials are missing/);
	assert.equal(calls.filter(call => call.args.includes('create')).length, 1);
	await writeFile(paths.settings, 'null');
	await assert.rejects(readRemoteSettings(dataDir), /Invalid saved/);
	await rm(paths.settings);
	await assert.rejects(setup(), /without remote.json/);
});

test('mac setup installs a missing cloudflared with Homebrew and other platforms give installation instructions', async () => {
	const calls = [];
	let installed = false;
	const run = async (command, args) => {
		calls.push([command, ...args]);
		if (command === 'cloudflared' && !installed) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
		if (args.includes('install')) installed = true;
	};
	await ensureCloudflared({ run, platform: 'darwin' });
	assert.deepEqual(calls, [['cloudflared', '--version'], ['brew', '--version'], ['brew', 'install', 'cloudflared'], ['cloudflared', '--version']]);
	installed = false;
	await assert.rejects(ensureCloudflared({ run, platform: 'linux' }), /Install cloudflared/);
	assert.ok(!Object.keys(tunnelEnvironment()).some(key => key.startsWith('TUNNEL_')));
});

// The real Crate CLI/workerd and real child processes run against isolated
// directories. Only Cloudflare's external control plane/connector is faked.
test('one-command setup and saved start supervise the tunnel, preserve tokens, and release storage', { timeout: 90_000 }, async t => {
	const directory = await mkdtemp(join(tmpdir(), 'crate-tunnel-cli-'));
	const dataDir = join(directory, 'data');
	const bin = join(directory, 'bin');
	await mkdir(bin);
	const paths = remotePaths(dataDir);
	const fixture = `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (Object.keys(process.env).some(key => key.startsWith('TUNNEL_'))) process.exit(8);
if (args.includes('create')) writeFileSync(args[args.indexOf('--credentials-file') + 1], ${JSON.stringify(JSON.stringify(credentials))});
if (args.includes('run')) {
  const configPath = args[args.indexOf('--config') + 1];
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (config.tunnel !== ${JSON.stringify(tunnelId)} || config.ingress.at(-1).service !== 'http_status:404') process.exit(9);
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1000);
  writeFileSync(configPath + '.pid', String(process.pid));
}
`;
	await writeFile(join(bin, 'cloudflared'), fixture, { mode: 0o755 });
	const socket = createServer();
	await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
	const port = socket.address().port;
	await new Promise(resolve => socket.close(resolve));
	const cli = new URL('./local-server.mjs', import.meta.url).pathname;
	let child;
	let tunnelPid;
	t.after(async () => {
		if (child?.exitCode === null) child.kill('SIGKILL');
		if (tunnelPid) { try { process.kill(tunnelPid, 'SIGKILL'); } catch { /* Already stopped. */ } }
		await rm(directory, { recursive: true, force: true });
	});
	async function launch(args) {
		await rm(`${paths.config}.pid`, { force: true });
		child = spawn(process.execPath, [cli, ...args, '--data-dir', dataDir], {
			stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
		});
		const exited = once(child, 'exit');
		let output = '';
		let errors = '';
		child.stdout.on('data', chunk => { output += chunk; });
		child.stderr.on('data', chunk => { errors += chunk; });
		const deadline = Date.now() + 40_000;
		while (!output.includes('Press Ctrl+C') || !(await stat(`${paths.config}.pid`).catch(() => null))) {
			assert.equal(child.exitCode, null, `${errors}\n${output}`);
			assert.ok(Date.now() < deadline, `Startup timeout: ${errors}\n${output}`);
			await delay(50);
		}
		tunnelPid = Number(await readFile(`${paths.config}.pid`, 'utf8'));
		return { output, exited, errors: () => errors };
	}
	const first = await launch(['setup', '--hostname', 'crate.example.com', '--port', String(port), '--name', 'Test device']);
	const code = /crate-pair-[a-f0-9]{64}/.exec(first.output)?.[0];
	assert.ok(code);
	const exchange = await fetch(`http://127.0.0.1:${port}/__crate/pair`, { method: 'POST', body: JSON.stringify({ code }) });
	assert.equal(exchange.status, 200);
	const { authToken: token } = await exchange.json();
	assert.ok(first.output.includes('https://crate.example.com'));
	const health = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: `Bearer ${token}` } });
	assert.equal(health.status, 200);
	await health.text();
	child.kill('SIGTERM');
	assert.equal((await first.exited)[0], 0, first.errors());
	assert.throws(() => process.kill(tunnelPid, 0), /ESRCH/);
	assert.equal(await stat(join(dataDir, 'server.lock')).catch(() => null), null);
	const second = await launch(['start']);
	assert.ok(!second.output.includes(token));
	assert.ok(second.output.includes('https://crate.example.com'));
	process.kill(tunnelPid, 'SIGKILL');
	assert.equal((await second.exited)[0], 1, second.errors());
	assert.match(second.errors(), /Cloudflare Tunnel stopped/);
	assert.equal(await stat(join(dataDir, 'server.lock')).catch(() => null), null);
	await rm(paths.credentials);
	const failed = spawn(process.execPath, [cli, 'start', '--data-dir', dataDir], { stdio: ['ignore', 'pipe', 'pipe'] });
	let errors = '';
	failed.stderr.on('data', chunk => { errors += chunk; });
	assert.equal((await once(failed, 'exit'))[0], 1);
	assert.match(errors, /credentials are missing/);
	assert.equal(await stat(join(dataDir, 'server.lock')).catch(() => null), null);
});
