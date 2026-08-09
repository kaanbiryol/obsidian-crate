import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import chokidar from 'chokidar';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const watchedPaths = [
	path.join(rootDir, 'src'),
	path.join(rootDir, 'scripts'),
	...[
		'manifest.json',
		'package.json',
		'postcss.config.js',
		'tailwind.config.js',
		'tailwind.theme.js',
		'tsconfig.json',
		'vite.config.mts',
	].map(fileName => path.join(rootDir, fileName)),
];

let activeChild = null;
let buildQueued = false;
let buildRunning = false;
let debounceTimer = null;
let shuttingDown = false;

const watcher = chokidar.watch(watchedPaths, {
	ignoreInitial: true,
	interval: 300,
	usePolling: true,
});

watcher.on('all', (_eventName, changedPath) => {
	queueBuild(path.relative(rootDir, changedPath));
});
watcher.on('error', (error) => {
	console.error(`Development watcher error: ${error instanceof Error ? error.message : String(error)}`);
});

console.log('Watching plugin, Worker, and build configuration files...');
void runBuild();

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

function queueBuild(changedPath) {
	if (shuttingDown) {
		return;
	}

	console.log(`Change detected: ${changedPath}`);
	buildQueued = true;

	if (buildRunning) {
		return;
	}

	if (debounceTimer) {
		clearTimeout(debounceTimer);
	}

	debounceTimer = setTimeout(() => {
		debounceTimer = null;
		void runBuild();
	}, 100);
}

async function runBuild() {
	if (buildRunning || shuttingDown) {
		return;
	}

	buildRunning = true;

	try {
		do {
			buildQueued = false;
			console.log('Building development plugin...');

			const workerExitCode = await runNpmScript('build:worker');
			if (workerExitCode !== 0) {
				console.error(`Worker build failed with exit code ${workerExitCode}. Watching for changes...`);
				continue;
			}

			const pluginExitCode = await runNpmScript('build:plugin:dev');
			if (pluginExitCode !== 0) {
				console.error(`Plugin build failed with exit code ${pluginExitCode}. Watching for changes...`);
				continue;
			}

			console.log('Development plugin is ready. Reload Crate in Obsidian to test it.');
		} while (buildQueued && !shuttingDown);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
	} finally {
		buildRunning = false;
	}
}

function runNpmScript(scriptName) {
	return new Promise((resolve, reject) => {
		const child = spawn(npmCommand, ['run', scriptName], {
			cwd: rootDir,
			stdio: 'inherit',
		});

		activeChild = child;
		child.once('error', reject);
		child.once('exit', (code) => {
			activeChild = null;
			resolve(code ?? 1);
		});
	});
}

function shutdown() {
	shuttingDown = true;
	if (debounceTimer) {
		clearTimeout(debounceTimer);
	}

	void watcher.close();
	activeChild?.kill('SIGTERM');
}
