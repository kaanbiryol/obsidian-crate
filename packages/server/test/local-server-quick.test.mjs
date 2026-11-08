import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { quickTunnelOrigin, startQuickTunnel } from '../src/local-server-quick.mjs';
import { cloudflaredVersion, installCloudflared } from '../src/local-server-cloudflared.mjs';

test('Quick Tunnel discovery accepts only complete HTTPS trycloudflare origins', () => {
	assert.equal(quickTunnelOrigin('Visit https://clear-blue-sky.trycloudflare.com\n'), 'https://clear-blue-sky.trycloudflare.com');
	for (const value of ['http://blue.trycloudflare.com', 'https://blue.trycloudflare.com.evil.test ', 'https://blue.trycloudflare.co', 'https://user@blue.trycloudflare.com ']) {
		assert.equal(quickTunnelOrigin(value), null);
	}
});

test('automatic installation refuses an unverified download', async t => {
	const cacheDir = await mkdtemp(join(tmpdir(), 'crate-download-test-'));
	t.after(() => rm(cacheDir, { recursive: true, force: true }));
	const run = async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
	await assert.rejects(installCloudflared({ cacheDir, platform: 'linux', arch: 'x64', run,
		fetchAsset: async () => new Response('invalid binary') }), /checksum mismatch/);
	assert.deepEqual(await readdir(join(cacheDir, cloudflaredVersion, 'linux-x64')), []);
});

test('automatic installation retries network and server errors three times', async t => {
	const cacheDir = await mkdtemp(join(tmpdir(), 'crate-download-retry-test-'));
	t.after(() => rm(cacheDir, { recursive: true, force: true }));
	const run = async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
	const install = (responses, signal) => {
		const signals = [];
		const fetchAsset = async (url, init) => {
			signals.push(init.signal);
			const next = responses.shift();
			return typeof next === 'function' ? next() : next;
		};
		return { signals, result: installCloudflared({ cacheDir, platform: 'linux', arch: 'x64', run, fetchAsset, signal }) };
	};
	// Stub bytes never match the pinned checksum, so reaching that check proves the 200 after a failure was used.
	let attempt = install([new Response(null, { status: 504 }), new Response('stub binary')]);
	await assert.rejects(attempt.result, /checksum mismatch/);
	assert.equal(attempt.signals.length, 2);
	assert.notEqual(attempt.signals[0], attempt.signals[1], 'each attempt gets its own timeout');

	attempt = install([() => { throw new TypeError('fetch failed'); }, new Response('stub binary')]);
	await assert.rejects(attempt.result, /checksum mismatch/);
	assert.equal(attempt.signals.length, 2);

	attempt = install([504, 502, 504].map(status => new Response(null, { status })));
	await assert.rejects(attempt.result, /HTTP 504/);
	assert.equal(attempt.signals.length, 3);

	attempt = install([new Response(null, { status: 404 }), new Response('stub binary')]);
	await assert.rejects(attempt.result, /HTTP 404/);
	assert.equal(attempt.signals.length, 1, 'client errors are not retried');

	const controller = new AbortController();
	attempt = install([() => { controller.abort(); return new Response(null, { status: 503 }); }, new Response('stub binary')], controller.signal);
	await assert.rejects(attempt.result, { name: 'AbortError' });
	assert.equal(attempt.signals.length, 1, 'an abort stops before the next attempt');
});

test('Quick Tunnel reads split output, isolates configuration, and stops its child', async t => {
	const directory = await mkdtemp(join(tmpdir(), 'crate-quick-test-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const command = join(directory, 'cloudflared');
	const record = join(directory, 'record.json');
	await writeFile(command, `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const config = args[args.indexOf('--config') + 1];
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ pid: process.pid, config, args, contents: readFileSync(config, 'utf8') }));
process.stderr.write('Your Quick Tunnel: https://clear-blue-');
setTimeout(() => process.stderr.write('sky.trycloudflare.com\\n'), 20);
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`, { mode: 0o755 });
	const tunnel = await startQuickTunnel({ command, port: 43210 });
	t.after(() => tunnel.stop());
	assert.equal(tunnel.origin, 'https://clear-blue-sky.trycloudflare.com');
	const state = JSON.parse(await readFile(record, 'utf8'));
	assert.ok(state.args.includes('http://127.0.0.1:43210'));
	assert.deepEqual(JSON.parse(state.contents), {});
	await tunnel.stop();
	assert.equal((await tunnel.exited).code, 0);
	await assert.rejects(readFile(state.config), { code: 'ENOENT' });
});

test('Quick Tunnel startup failure and timeout do not leave a child running', async t => {
	const directory = await mkdtemp(join(tmpdir(), 'crate-quick-failure-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await mkdir(join(directory, 'bin'));
	const command = join(directory, 'bin', 'cloudflared');
	await writeFile(command, `#!${process.execPath}\nprocess.exit(7);\n`, { mode: 0o755 });
	await assert.rejects(startQuickTunnel({ command, port: 4000 }), /stopped \(7\)/);
	await writeFile(command, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
	await assert.rejects(startQuickTunnel({ command, port: 4000, timeout: 100 }), /Timed out/);
});
