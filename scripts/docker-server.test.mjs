import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '..');
function docker(args, input = '') {
	return new Promise((resolve, reject) => {
		const child = spawn('docker', args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
		let stdout = '', stderr = '';
		child.stdout.on('data', chunk => { stdout += chunk; });
		child.stderr.on('data', chunk => { stderr += chunk; });
		child.once('error', reject);
		child.once('close', code => resolve({ code, stdout, stderr }));
		child.stdin.end(input);
	});
}
const redact = value => value.replace(/[a-f0-9]{64}/g, '[redacted]');
function checked(result) {
	assert.equal(result.code, 0, redact(result.stderr + result.stdout));
	return result.stdout;
}

test('Docker persists sync data, rejects concurrent owners, and recovers after process death', { timeout: 180_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), 'crate-docker-'));
	const project = `crate-test-${randomUUID().slice(0, 8)}`;
	const connector = join(directory, 'cloudflared');
	const override = join(directory, 'compose.json');
	await writeFile(connector, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('test connector'); process.exit(0); }
const path = '/data/test-launch-count';
let count = 0;
try { count = Number(fs.readFileSync(path, 'utf8')); } catch {}
fs.writeFileSync(path, String(++count));
console.log('https://crate-test-' + count + '.trycloudflare.com');
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`, { mode: 0o755 });
	await writeFile(override, JSON.stringify({ services: { crate: {
		network_mode: 'none',
		volumes: [{ type: 'bind', source: connector, target: '/usr/local/bin/cloudflared', read_only: true }],
		healthcheck: { interval: '1s', timeout: '5s', start_period: '1s', retries: 20 },
	} } }));
	const args = ['compose', '-p', project, '-f', join(root, 'compose.yaml'), '-f', override];
	const compose = (...commands) => docker([...args, ...commands]);
	const evaluate = async source => checked(await docker([...args, 'exec', '-T', 'crate', 'node', '--input-type=module'], source));
	const readMetadata = () => evaluate("import {readFile} from 'node:fs/promises'; console.log(await readFile('/data/server/server.json', 'utf8'));");
	const request = async (path, options = {}) => JSON.parse(await evaluate(`
const response = await fetch(${JSON.stringify('http://127.0.0.1:8787' + path)}, {...${JSON.stringify(options)}, signal: AbortSignal.timeout(5000)});
console.log(JSON.stringify({status: response.status, body: await response.text()}));`));
	let container;
	async function ready(launch) {
		const deadline = Date.now() + 45_000;
		while (Date.now() < deadline) {
			const logs = checked(await compose('logs', '--no-color', 'crate'));
			const inspection = JSON.parse(checked(await docker(['inspect', container])))[0];
			if (logs.includes(`Server address to paste into Obsidian: https://crate-test-${launch}.trycloudflare.com`)
				&& inspection.State.Health?.Status === 'healthy') return logs;
			await delay(500);
		}
		assert.fail(redact(checked(await compose('logs', '--no-color', 'crate'))));
	}
	try {
		checked(await compose('up', '-d', '--no-build'));
		container = checked(await compose('ps', '-q', 'crate')).trim();
		const first = await ready(1);
		const code = /crate-pair-[a-f0-9]{64}/.exec(first)?.[0];
		assert.ok(code, 'First launch issues an expiring pairing code');
		const paired = await request('/__crate/pair', { method: 'POST', body: JSON.stringify({ code }) });
		assert.equal(paired.status, 200);
		const { authToken: token } = JSON.parse(paired.body);
		assert.equal((await request('/__crate/pair', { method: 'POST', body: JSON.stringify({ code }) })).status, 401);
		const live = checked(await compose('exec', '-T', 'crate', 'crate', 'pair', '--name', 'Second device'));
		const liveCode = /crate-pair-[a-f0-9]{64}/.exec(live)[0];
		assert.equal((await request('/__crate/pair', { method: 'POST', body: JSON.stringify({ code: liveCode }) })).status, 200);
		assert.equal((await evaluate('console.log(process.getuid())')).trim(), '1000');
		const metadata = await readMetadata();
		const info = JSON.parse((await request('/.well-known/crate')).body);
		const headers = { Authorization: `Bearer ${token}`, 'X-Crate-Protocol': String(info.protocol.current) };
		assert.equal((await request('/health')).status, 401);
		assert.equal((await request('/health', { headers })).status, 200);
		assert.equal((await request('/notifications')).status, 200);
		assert.equal((await request('/cdn-cgi/local/platform-proxy')).status, 404);
		const initial = await request('/sync/import', { method: 'POST', headers });
		assert.equal(initial.status, 200);
		assert.equal((await request('/sync/import/complete', { method: 'POST', headers, body: JSON.stringify({
			token: JSON.parse(initial.body).import.token, inventoryHash: createHash('sha256').update('[]').digest('hex'),
		}) })).status, 200);
		const uploaded = await request('/sync/upload?path=docker.txt', { method: 'PUT', headers: { ...headers,
			'Content-Type': 'text/plain', 'X-Crate-Expected-Hash': 'absent',
			'X-Crate-Upload-Operation': `e1_${String(info.reminderOperationDay).padStart(8, '0')}_${randomUUID()}`,
		}, body: 'persistent Docker bytes' });
		assert.equal(uploaded.status, 200, uploaded.body);
		// A second container must not remove the active runtime's lock or open D1.
		assert.equal((await compose('run', '--rm', '--no-deps', '-T', 'crate', 'add-device', '--name', 'blocked')).code, 73);
		assert.equal((await request('/health', { headers })).status, 200);
		checked(await compose('restart', 'crate'));
		await ready(2);
		assert.equal(await readMetadata(), metadata);
		assert.deepEqual(await request('/sync/download?path=docker.txt', { headers }), { status: 200, body: 'persistent Docker bytes' });
		// Kill the server process rather than manually stopping Docker's container,
		// so the configured restart policy must bring it back without user action.
		checked(await docker([...args, 'exec', '-T', 'crate', 'node', '-e',
			"process.kill(JSON.parse(require('node:fs').readFileSync('/data/server/server.lock', 'utf8')).pid, 'SIGKILL')"]));
		const afterCrash = await ready(3);
		assert.equal((afterCrash.match(/Access token \(shown once\)/g) || []).length, 0);
		assert.equal(await readMetadata(), metadata);
		assert.deepEqual(await request('/sync/download?path=docker.txt', { headers }), { status: 200, body: 'persistent Docker bytes' });
		assert.ok(JSON.parse(checked(await docker(['inspect', container])))[0].RestartCount > 0);
		checked(await compose('up', '-d', '--no-build', '--force-recreate'));
		container = checked(await compose('ps', '-q', 'crate')).trim();
		const recreated = await ready(4);
		assert.ok(!recreated.includes('Access token (shown once)'));
		assert.equal(await readMetadata(), metadata);
		assert.deepEqual(await request('/sync/download?path=docker.txt', { headers }), { status: 200, body: 'persistent Docker bytes' });
		checked(await compose('stop', 'crate'));
		assert.equal(JSON.parse(checked(await docker(['inspect', container])))[0].State.ExitCode, 0);
		const additional = checked(await compose('run', '--rm', '--no-deps', '-T', 'crate', 'add-device', '--name', 'Phone'));
		assert.match(additional, /Access token \(shown once\): [a-f0-9]{64}/);
	} finally {
		try { checked(await compose('down', '--volumes', '--remove-orphans')); }
		finally { await rm(directory, { recursive: true, force: true }); }
	}
});
