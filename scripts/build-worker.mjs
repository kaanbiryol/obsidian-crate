import { build } from 'esbuild';
import { createDevelopmentBuild } from './development-build.mjs';
import { developmentShortcut } from './development-shortcut.mjs';
import { builtinModules } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rawTextPlugin } from './raw-text-plugin.mjs';
import { createPwaAssetVersion } from './pwa-asset-version.mjs';
import { bundlePwaClient } from './pwa-client-build.mjs';
import { bundleServiceWorkerRuntime } from './service-worker-build.mjs';
import { collectServerInputs } from './server-build-inputs.mjs';
import { readingExtractionPlugin } from './reading-extraction-build.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const generatedDir = resolve(root, '.generated/cloudflare');
const development = process.argv.includes('--development') ? createDevelopmentBuild(root) : undefined;
// This identifies the Cloudflare service, not the Obsidian plugin release.
// Keeping it stable prevents an otherwise unrelated plugin version bump from
// changing the Worker bundle and prompting users to redeploy their server.
const serverVersion = 'crate';
const rawInputs = new Set();

function writeGeneratedJson(fileName, payload) {
	mkdirSync(generatedDir, { recursive: true });
	writeFileSync(
		resolve(generatedDir, fileName),
		`${JSON.stringify(payload, null, 2)}\n`,
		'utf-8',
	);
}

// The Worker serves the PWA shell from shared modules. Lint checks direct imports;
// this also catches host UI or React reached through a shared module.
const FORBIDDEN_WORKER_INPUTS = [/(^|\/)node_modules\/(react|react-dom|obsidian)\//, /^src\/(ui|reminders\/ui|reading\/ui)\/plugin\//];
function assertWorkerInputs(metafile) {
	const forbidden = Object.keys(metafile.inputs).filter(path => FORBIDDEN_WORKER_INPUTS.some(pattern => pattern.test(path)));
	if (forbidden.length) throw new Error(`The Worker bundle includes plugin UI or React code:\n${forbidden.map(path => `  ${path}`).join('\n')}`);
}

/** Self-hosted features the Cloudflare bundle must leave out: chunked uploads and their sweep. */
const SELF_HOSTED_ONLY = ['/sync/upload-session', '/sync-upload-session', '__crate__/upload-sessions/', 'chunked-uploads-v1', 'createMultipartUpload', 'Content-Range'];
function assertCloudflareBundle(code) {
	const found = SELF_HOSTED_ONLY.filter(marker => code.includes(marker));
	if (found.length) throw new Error(`The Cloudflare Worker bundle includes self-hosted code: ${found.join(', ')}`);
}

/** `selfHosted` builds the server package's Worker; the plugin deploys the other one to Cloudflare. */
async function buildWorkerBundle(pwaClientAssets, pwaAssetVersion, startupAssets, serviceWorkerRuntime, shortcut, { selfHosted, file }) {
	const result = await build({
		absWorkingDir: root,
		entryPoints: [resolve(root, 'src/cloudflare/worker/index.ts')],
		bundle: true,
		format: 'esm',
		platform: 'neutral',
		external: [...builtinModules, ...builtinModules.map(name => `node:${name}`)],
		// CommonJS dependencies require Node builtins; Workers do not expose import.meta.url.
		banner: { js: "import { createRequire } from 'node:module'; const require = createRequire('/worker.mjs');" },
		target: 'esnext',
		write: false,
		metafile: true,
		minify: true,
		legalComments: 'eof',
		mainFields: ['module', 'main'],
		conditions: ['worker', 'browser', 'import'],
		loader: { '.png': 'binary' },
		define: {
			__CRATE_SERVER_VERSION__: JSON.stringify(serverVersion),
      __CRATE_DEVELOPMENT_BUILD__: JSON.stringify(development ?? null),
			__CRATE_PWA_ASSET_VERSION__: JSON.stringify(pwaAssetVersion),
			__CRATE_PWA_CLIENT_ASSETS__: JSON.stringify(pwaClientAssets),
			__CRATE_PWA_STARTUP_ASSETS__: JSON.stringify(startupAssets),
			__CRATE_SERVICE_WORKER_JS__: JSON.stringify(serviceWorkerRuntime),
			__CRATE_DEVELOPMENT_SHORTCUT__: JSON.stringify(shortcut),
			__CRATE_SELF_HOSTED__: JSON.stringify(selfHosted),
		},
		plugins: [rawTextPlugin(path => rawInputs.add(path)), readingExtractionPlugin()],
	});

	assertWorkerInputs(result.metafile);
	const code = result.outputFiles[0].text;
	if (!selfHosted) assertCloudflareBundle(code);
	mkdirSync(generatedDir, { recursive: true });
	writeFileSync(resolve(generatedDir, file), code, 'utf-8');
	console.log(`${selfHosted ? 'Self-hosted' : 'Deployable'} Worker bundle written to .generated/cloudflare/${file}`);
	return result.metafile;
}

async function buildPwaClientBundle(serviceWorkerRuntime, shortcut) {
	const { assets, startupAssets, metafile } = await bundlePwaClient(root, { developmentShortcut: shortcut !== null });
	const version = createPwaAssetVersion({ ...assets, 'service-worker-runtime.js': serviceWorkerRuntime }, root, path => rawInputs.add(path));
	const script = assets['app.js'];
	if (!script) throw new Error('PWA client build did not emit app.js');
	writeGeneratedJson('pwa-client.json', {
		version,
		script,
		assets,
		startupAssets,
	});
	console.log('PWA client bundle written to .generated/cloudflare/pwa-client.json');
	return { assets, version, startupAssets, metafile };
}

// Release gates build once, then set CRATE_WORKER_PREBUILT=1 so nested build:worker
// calls reuse that output. Missing output or an input edited after the build fails.
function assertPrebuiltWorker(rootDir) {
	const generated = resolve(rootDir, '.generated/cloudflare');
	let identity, inputs, builtAt;
	try {
		identity = JSON.parse(readFileSync(resolve(generated, 'build-identity.json'), 'utf8'));
		inputs = JSON.parse(readFileSync(resolve(generated, 'server-inputs.json'), 'utf8'));
		builtAt = Math.min(...['worker.mjs', 'worker-self-hosted.mjs', 'pwa-client.json', 'build-identity.json'].map(name => statSync(resolve(generated, name)).mtimeMs));
	} catch (error) {
		throw new Error(`CRATE_WORKER_PREBUILT=1 requires a completed npm run build:worker: ${error.message}`, { cause: error });
	}
	if (identity.development !== null) throw new Error('CRATE_WORKER_PREBUILT=1 found a development Worker build; run npm run build:worker.');
	const stale = inputs.filter(path => !existsSync(resolve(rootDir, path)) || statSync(resolve(rootDir, path)).mtimeMs > builtAt);
	if (stale.length) throw new Error(`CRATE_WORKER_PREBUILT=1 found Worker inputs changed after the build; run npm run build:worker:\n${stale.map(path => `  ${path}`).join('\n')}`);
}

if (process.env.CRATE_WORKER_PREBUILT === '1' && !development) {
	assertPrebuiltWorker(root);
	console.log('Reusing the prebuilt Worker in .generated/cloudflare (CRATE_WORKER_PREBUILT=1)');
	process.exit(0);
}

const serviceWorkerRuntime = await bundleServiceWorkerRuntime(root);
const shortcut = development ? await developmentShortcut(root) : null;
const pwaClient = await buildPwaClientBundle(serviceWorkerRuntime.script, shortcut);
const workerArgs = [pwaClient.assets, pwaClient.version, pwaClient.startupAssets, serviceWorkerRuntime.script, shortcut];
const workerMetafile = await buildWorkerBundle(...workerArgs, { selfHosted: false, file: 'worker.mjs' });
const selfHostedMetafile = await buildWorkerBundle(...workerArgs, { selfHosted: true, file: 'worker-self-hosted.mjs' });
writeGeneratedJson('server-inputs.json', await collectServerInputs(root, [workerMetafile, selfHostedMetafile, pwaClient.metafile, serviceWorkerRuntime.metafile], rawInputs));
writeGeneratedJson('build-identity.json', { development: development ?? null, workerSha256: createHash('sha256').update(readFileSync(resolve(generatedDir, 'worker.mjs'))).digest('hex'), release: JSON.parse(readFileSync(resolve(root, 'src/cloudflare/server-release.json'), 'utf8')) });
