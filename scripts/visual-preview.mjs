import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Playwright reloads its config in workers. Inherit one run identity and port.
export async function visualTestRun() {
	if (process.env.CRATE_VISUAL_TEST_RUN) return JSON.parse(process.env.CRATE_VISUAL_TEST_RUN);
	const socket = createServer();
	await new Promise((resolve, reject) => {
		socket.once('error', reject);
		socket.listen(0, '127.0.0.1', resolve);
	});
	const port = socket.address().port;
	await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
	const id = randomUUID();
	const run = { id, directory: resolve('.generated/visual-runs', id), port };
	process.env.CRATE_VISUAL_TEST_RUN = JSON.stringify(run);
	return run;
}

export async function startVisualPreview({ directory, port = 0, stylesPath = resolve('dist/styles.css') }) {
	// Read once before building; neither Vite nor the browser watches mutable dist/.
	let styles;
	try {
		styles = await readFile(stylesPath, 'utf8');
	} catch (cause) {
		throw new Error('Visual tests need built plugin styles. Run npm run build:plugin before testing.', { cause });
	}
	await mkdir(directory, { recursive: true });
	const snapshot = resolve(directory, 'styles.css');
	await writeFile(snapshot, styles);
	const { build, preview } = await import('vite');
	const config = {
		configFile: resolve('vite.visual.config.mts'),
		resolve: { alias: { '@plugin-build': directory } },
		build: { outDir: resolve(directory, 'gallery'), emptyOutDir: true },
	};
	await build(config);
	return preview({ ...config, preview: { host: '127.0.0.1', port, strictPort: true } });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const run = JSON.parse(process.env.CRATE_VISUAL_TEST_RUN ?? 'null');
	if (!run) throw new Error('Start the isolated visual preview through Playwright. For live editing, run npm run preview:ui.');
	const server = await startVisualPreview(run);
	server.printUrls();
	for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void server.close(); });
}
