import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

async function readText(path) {
	try {
		return await readFile(path, 'utf8');
	} catch (error) {
		throw new Error(`Missing release artifact: ${path}`, { cause: error });
	}
}

async function readJson(path) {
	const text = await readText(path);
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error(`Invalid JSON in ${path}`, { cause: error });
	}
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

const [packageJson, manifest, versions, wrangler, pluginBundle, styles, workerBundle, d1Schema] = await Promise.all([
	readJson('package.json'),
	readJson('manifest.json'),
	readJson('versions.json'),
	readJson('wrangler.jsonc'),
	readText('dist/main.js'),
	readText('dist/styles.css'),
	readText('.generated/cloudflare/worker.mjs'),
	readText('src/cloudflare/schema.sql'),
]);

assert(packageJson.version === manifest.version, 'package.json and manifest.json versions must match');
assert(
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version),
	'manifest.json version must use x.y.z semantic versioning',
);
assert(versions[manifest.version] === manifest.minAppVersion, 'versions.json must map the release to manifest.minAppVersion');
assert(typeof manifest.id === 'string' && manifest.id.length > 0, 'manifest.id is required');
assert(typeof manifest.name === 'string' && manifest.name.length > 0, 'manifest.name is required');
assert(typeof manifest.description === 'string' && manifest.description.length > 0, 'manifest.description is required');
assert(typeof manifest.isDesktopOnly === 'boolean', 'manifest.isDesktopOnly must be a boolean');
assert(pluginBundle.length > 0, 'dist/main.js must not be empty');
assert(styles.length > 0, 'dist/styles.css must not be empty');
assert(workerBundle.length > 0, 'generated Worker bundle must not be empty');

for (const forbiddenMarker of [
	'Cloudflare API token',
	'class SetupCoordinator',
]) {
	assert(!pluginBundle.includes(forbiddenMarker), `Plugin bundle contains server/setup marker: ${forbiddenMarker}`);
}
// Verify the actual gzip literals emitted into the plugin, independent of minified names.
const embeddedArtifacts = new Map();
for (const match of pluginBundle.matchAll(/["'`](H4sI[A-Za-z0-9+/=]+)["'`]/g)) {
	const decoded = gunzipSync(Buffer.from(match[1], 'base64'));
	const digest = createHash('sha256').update(decoded).digest('hex');
	embeddedArtifacts.set(digest, decoded.toString('utf8'));
}
for (const [name, source] of [['Worker', workerBundle], ['D1 schema', d1Schema]]) {
	const digest = createHash('sha256').update(source).digest('hex');
	assert(embeddedArtifacts.get(digest) === source, `Plugin bundle is missing the current compressed ${name} artifact`);
	assert(pluginBundle.includes(digest), `Plugin bundle is missing the ${name} integrity hash`);
}
assert(
	d1Schema.includes('CREATE TABLE IF NOT EXISTS auth_tokens'),
	'Plugin bundle is missing the initial D1 schema artifact',
);
assert(
	d1Schema.includes('CREATE TABLE IF NOT EXISTS crate_schema'),
	'Plugin bundle is missing the D1 schema-version baseline',
);
assert(pluginBundle.includes('https://dash.cloudflare.com/oauth2/auth'), 'Plugin bundle is missing the Cloudflare OAuth entry point');
assert(
	pluginBundle.includes('https://crate.kaanbiryol.com/oauth/callback/'),
	'Plugin bundle is missing the static OAuth callback URL',
);

for (const requiredMarker of ['/.well-known/crate', 'notifications-v1']) {
	assert(workerBundle.includes(requiredMarker), `Worker bundle is missing required route/capability: ${requiredMarker}`);
}
for (const forbiddenMarker of ['/setup/enroll', '/setup/claim', '/auth/enrollment', 'enrollment-v1']) {
	assert(!workerBundle.includes(forbiddenMarker), `Worker bundle exposes retired device enrollment: ${forbiddenMarker}`);
}

assert(wrangler.main === '.generated/cloudflare/worker.mjs', 'wrangler main must target the generated Worker bundle');
assert(wrangler.d1_databases?.some(binding => binding.binding === 'DB'), 'wrangler DB binding is required');
assert(wrangler.r2_buckets?.some(binding => binding.binding === 'BUCKET'), 'wrangler BUCKET binding is required');
assert(wrangler.ratelimits?.some(binding => binding.name === 'NOTIFICATION_REQUEST_LIMITER' && binding.simple?.limit === 60 && binding.simple?.period === 60), 'notification rate limit binding is required');
for (const bindingName of ['REMINDER_ALARMS']) {
	assert(
		wrangler.durable_objects?.bindings?.some(binding => binding.name === bindingName),
		`wrangler ${bindingName} Durable Object binding is required`,
	);
}

console.log(`Release artifacts verified for Crate ${manifest.version}`);
