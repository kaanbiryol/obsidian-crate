import { chmod, copyFile, cp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const destination = join(root, 'dist', 'server');
const packageInfo = JSON.parse(await readFile(join(root, 'packages/server/package.json'), 'utf8'));
const repositoryInfo = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (packageInfo.crateServerRuntime !== repositoryInfo.devDependencies.miniflare
	|| packageInfo.engines.node !== repositoryInfo.engines.node) throw new Error('Server package runtime and Node versions must match the tested repository versions.');
await rm(destination, { recursive: true, force: true });
await mkdir(join(destination, 'scripts'), { recursive: true });
await mkdir(join(destination, 'assets'));
// npm ignores a dependency's overrides. Ship Miniflare's unchanged JavaScript
// assets and declare its runtime dependencies here to retain our sharp fix.
// Native workerd/sharp binaries are still installed for the user's platform.
const require = createRequire(import.meta.url);
const miniflareRoot = resolve(require.resolve('miniflare'), '../../..');
const miniflareInfo = JSON.parse(await readFile(join(miniflareRoot, 'package.json'), 'utf8'));
if (miniflareInfo.version !== packageInfo.crateServerRuntime) throw new Error('Installed Miniflare does not match the server package.');
for (const [name, version] of Object.entries(miniflareInfo.dependencies)) {
	const expected = repositoryInfo.overrides?.miniflare?.[name] ?? version;
	if (packageInfo.dependencies[name] !== expected) throw new Error(`Server package dependency ${name} must match the tested runtime.`);
}
const vendor = join(destination, 'vendor/miniflare');
await mkdir(vendor, { recursive: true });
await cp(join(miniflareRoot, 'dist'), join(vendor, 'dist'), { recursive: true });
await copyFile(join(miniflareRoot, 'package.json'), join(vendor, 'package.json'));
await copyFile(join(root, 'packages/server/MINIFLARE_LICENSE'), join(vendor, 'LICENSE'));
for (const file of ['package.json', 'npm-shrinkwrap.json', 'README.md']) {
	await copyFile(join(root, 'packages/server', file), join(destination, file));
}
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await copyFile(join(root, file), join(destination, file));
for (const file of await readdir(join(root, 'scripts'))) {
	if ((file.startsWith('local-server') && file.endsWith('.mjs') && !file.endsWith('.test.mjs')) || file === 'crate-server.mjs') {
		await copyFile(join(root, 'scripts', file), join(destination, 'scripts', file));
	}
}
await chmod(join(destination, 'scripts/crate-server.mjs'), 0o755);
await copyFile(join(root, '.generated/cloudflare/worker.mjs'), join(destination, 'assets/worker.mjs'));
await copyFile(join(root, 'src/cloudflare/schema.sql'), join(destination, 'assets/schema.sql'));
await copyFile(join(root, 'src/cloudflare/server-release.json'), join(destination, 'assets/server-release.json'));
await cp(join(root, 'src/cloudflare/migrations'), join(destination, 'assets/migrations'), { recursive: true });
console.log(`Standalone server package prepared in ${destination}`);
