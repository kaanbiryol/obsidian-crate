import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// Playwright reloads its config in workers. Inherit one run identity and port.
export async function createVisualTestRun() {
	const socket = createServer();
	await new Promise((resolve, reject) => {
		socket.once('error', reject);
		socket.listen(0, '127.0.0.1', resolve);
	});
	const port = socket.address().port;
	await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
	const id = randomUUID();
	const run = { id, directory: resolve('.generated/visual-runs', id), port };
	return run;
}

if (import.meta.main) {
	const run = await createVisualTestRun();
	const result = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(2)], {
		stdio: 'inherit', env: { ...process.env, CRATE_VISUAL_TEST_RUN: JSON.stringify(run) },
	});
	if (result.error) throw result.error;
	process.exitCode = result.status ?? 1;
}
