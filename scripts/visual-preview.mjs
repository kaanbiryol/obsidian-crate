import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
	if (!run) throw new Error('Run visual tests through node scripts/visual-test-run.mjs. For live editing, run npm run preview:ui.');
	const server = await startVisualPreview(run);
	server.printUrls();
	for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void server.close(); });
}
