import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
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

// A run's gallery snapshot, Playwright results and HTML report. Other runs are untouched.
const visualRunOutputs = (run, root = process.cwd()) => [
	run.directory,
	resolve(root, 'test-results', `visual-${run.id}`),
	resolve(root, 'playwright-report', `visual-${run.id}`),
];

export async function removeVisualRunOutputs(run, root) {
	await Promise.all(visualRunOutputs(run, root).map(path => rm(path, { recursive: true, force: true })));
}

if (import.meta.main) {
	const run = await createVisualTestRun();
	const result = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(2)], {
		stdio: 'inherit', env: { ...process.env, CRATE_VISUAL_TEST_RUN: JSON.stringify(run) },
	});
	if (result.error) throw result.error;
	// Failed runs keep their output for diagnosis; CI uploads it as artifacts.
	if (result.status === 0 && !process.env.CI) await removeVisualRunOutputs(run);
	process.exitCode = result.status ?? 1;
}
