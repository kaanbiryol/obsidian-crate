import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { findTailscale, startTailscaleFunnel, tailscaleHostname } from '../src/local-server-tailscale.mjs';
import { readRemoteSettings, remotePaths, saveTailscaleSettings } from '../src/local-server-tunnel.mjs';

const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
const status = (value = {}) => async () => ({ stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'my-mac.tail1234.ts.net.' }, ...value }) });

test('finds the Tailscale CLI on PATH or inside the Mac app', async () => {
	assert.equal(await findTailscale({ platform: 'linux', run: async () => ({}) }), 'tailscale');
	const tried = [];
	const command = await findTailscale({ platform: 'darwin', run: async cli => { tried.push(cli); if (cli === 'tailscale') throw missing(); return {}; } });
	assert.match(command, /Tailscale\.app/);
	assert.deepEqual(tried, ['tailscale', command]);
	await assert.rejects(findTailscale({ platform: 'linux', run: async () => { throw missing(); } }), /Install Tailscale/);
});

test('reads the stable ts.net name only from a connected client', async () => {
	assert.equal(await tailscaleHostname('tailscale', { run: status() }), 'my-mac.tail1234.ts.net');
	await assert.rejects(tailscaleHostname('tailscale', { run: status({ BackendState: 'NeedsLogin' }) }), /not connected/);
	await assert.rejects(tailscaleHostname('tailscale', { run: status({ Self: { DNSName: 'my-mac.' } }) }), /MagicDNS/);
	await assert.rejects(tailscaleHostname('tailscale', { run: async () => ({ stdout: 'not json' }) }), /Tailscale status/);
});

test('Funnel runs in the foreground for the saved port and refuses a renamed computer', async () => {
	const started = [];
	const start = (command, args) => { started.push([command, ...args]); return { exited: new Promise(() => {}) }; };
	await startTailscaleFunnel({ hostname: 'my-mac.tail1234.ts.net', port: 8800 }, undefined, { run: status(), platform: 'linux', start });
	assert.deepEqual(started, [['tailscale', 'funnel', '--https=443', 'http://127.0.0.1:8800']]);
	await assert.rejects(startTailscaleFunnel({ hostname: 'old-mac.tail1234.ts.net', port: 8800 }, undefined, { run: status(), platform: 'linux', start }), /Rename the computer back/);
	assert.equal(started.length, 1);
});

test('saved Funnel settings keep their address and reject other setups', async t => {
	const directory = await mkdtemp(join(tmpdir(), 'crate-tailscale-settings-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const dataDir = join(directory, 'data');
	await saveTailscaleSettings(dataDir, 'my-mac.tail1234.ts.net', 8787);
	assert.deepEqual(await readRemoteSettings(dataDir), { format: 1, mode: 'tailscale', hostname: 'my-mac.tail1234.ts.net', port: 8787 });
	assert.equal((await stat(remotePaths(dataDir).settings)).mode & 0o777, 0o600);
	await saveTailscaleSettings(dataDir, 'my-mac.tail1234.ts.net', 8787);
	await assert.rejects(saveTailscaleSettings(dataDir, 'new-mac.tail1234.ts.net', 8787), /already has a saved address/);
	await writeFile(remotePaths(dataDir).settings, JSON.stringify({ format: 1, mode: 'tailscale', hostname: 'crate.example.com', port: 8787 }));
	await assert.rejects(readRemoteSettings(dataDir), /Invalid saved Tailscale/);
});

// The real Crate CLI/workerd run against isolated directories; only the Tailscale client is faked.
test('setup --tailscale and saved start supervise Funnel, keep the address, and release storage', { timeout: 90_000 }, async t => {
	const directory = await mkdtemp(join(tmpdir(), 'crate-tailscale-cli-'));
	const dataDir = join(directory, 'data');
	const bin = join(directory, 'bin');
	const pidFile = join(directory, 'funnel.pid');
	await mkdir(bin);
	await writeFile(join(bin, 'tailscale'), `#!${process.execPath}
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'version') process.exit(0);
if (args[0] === 'status') { console.log(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'crate-test.tail1234.ts.net.' } })); process.exit(0); }
if (args[0] !== 'funnel' || args[1] !== '--https=443' || !/^http:\\/\\/127\\.0\\.0\\.1:\\d+$/.test(args[2])) process.exit(9);
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
writeFileSync(process.env.FAKE_FUNNEL_PID, String(process.pid));
`, { mode: 0o755 });
	const socket = createServer();
	await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
	const port = socket.address().port;
	await new Promise(resolve => socket.close(resolve));
	const cli = new URL('../../../scripts/local-server.mjs', import.meta.url).pathname;
	let child;
	let funnelPid;
	t.after(async () => {
		if (child?.exitCode === null) child.kill('SIGKILL');
		if (funnelPid) { try { process.kill(funnelPid, 'SIGKILL'); } catch { /* Already stopped. */ } }
		await rm(directory, { recursive: true, force: true });
	});
	async function launch(args) {
		await rm(pidFile, { force: true });
		child = spawn(process.execPath, [cli, ...args, '--data-dir', dataDir], {
			stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_FUNNEL_PID: pidFile },
		});
		const exited = once(child, 'exit');
		let output = '';
		let errors = '';
		child.stdout.on('data', chunk => { output += chunk; });
		child.stderr.on('data', chunk => { errors += chunk; });
		const deadline = Date.now() + 40_000;
		while (!output.includes('Press Ctrl+C') || !(await stat(pidFile).catch(() => null))) {
			assert.equal(child.exitCode, null, `${errors}\n${output}`);
			assert.ok(Date.now() < deadline, `Startup timeout: ${errors}\n${output}`);
			await delay(50);
		}
		funnelPid = Number(await readFile(pidFile, 'utf8'));
		return { output, exited, errors: () => errors };
	}
	const first = await launch(['setup', '--tailscale', '--port', String(port), '--name', 'Test device']);
	assert.ok(first.output.includes('Server address to paste into Obsidian: https://crate-test.tail1234.ts.net'));
	assert.match(first.output, /crate-pair-[a-f0-9]{64}/);
	child.kill('SIGTERM');
	assert.equal((await first.exited)[0], 0, first.errors());
	assert.throws(() => process.kill(funnelPid, 0), /ESRCH/);
	assert.equal(await stat(join(dataDir, 'server.lock')).catch(() => null), null);
	const second = await launch(['start']);
	assert.ok(second.output.includes('https://crate-test.tail1234.ts.net'));
	process.kill(funnelPid, 'SIGKILL');
	assert.equal((await second.exited)[0], 1, second.errors());
	assert.match(second.errors(), /Tailscale Funnel stopped/);
	assert.equal(await stat(join(dataDir, 'server.lock')).catch(() => null), null);
	const conflict = spawn(process.execPath, [cli, 'setup', '--hostname', 'crate.example.com', '--data-dir', dataDir], { stdio: ['ignore', 'pipe', 'pipe'] });
	let errors = '';
	conflict.stderr.on('data', chunk => { errors += chunk; });
	assert.equal((await once(conflict, 'exit'))[0], 1);
	assert.match(errors, /uses Tailscale Funnel/);
});
