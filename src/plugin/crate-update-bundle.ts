import { sha256Hex } from '../platform/sha256';
import { isRecord, isSha256Hex } from '../platform/validation';

/**
 * A Crate release copied between this person's own devices through the vault.
 * One file carries all three plugin files so a device never sees half an update.
 * The plugin folder itself stays local; see docs/sync-pipeline.md.
 */
const CRATE_UPDATE_FORMAT = 1;
/** Install order: `manifest.json` last, so Obsidian lists the new version only once its code is in place. */
export const CRATE_UPDATE_FILES = ['styles.css', 'main.js', 'manifest.json'] as const;
export type CrateUpdateFile = typeof CRATE_UPDATE_FILES[number];

export interface CrateUpdateBundle {
	format: typeof CRATE_UPDATE_FORMAT;
	id: string;
	version: string;
	minAppVersion: string;
	files: Record<CrateUpdateFile, { sha256: string; content: string }>;
}

interface PluginManifestFields { id: string; version: string; minAppVersion: string }

const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const BUNDLE_NAME = /^((?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8}))\.json$/;

export const isPluginVersion = (value: unknown): value is string => typeof value === 'string' && VERSION.test(value);

/** Release versions are plain `major.minor.patch`, with no leading `v`. */
export function compareVersions(a: string, b: string): number {
	const left = a.split('.').map(Number), right = b.split('.').map(Number);
	for (let index = 0; index < 3; index++) {
		const difference = (left[index] ?? 0) - (right[index] ?? 0);
		if (difference) return Math.sign(difference);
	}
	return 0;
}

export const crateUpdateFolder = (configDir: string): string => `${configDir}/crate-update`;
export const crateUpdatePath = (configDir: string, version: string): string => `${crateUpdateFolder(configDir)}/${version}.json`;
export const isCrateUpdatePath = (path: string, configDir: string): boolean => path.startsWith(`${crateUpdateFolder(configDir)}/`);

/** The version a bundle path names, or null for any other file, such as a conflict copy. */
export function crateUpdateVersion(path: string, configDir: string): string | null {
	if (!isCrateUpdatePath(path, configDir)) return null;
	return BUNDLE_NAME.exec(path.slice(crateUpdateFolder(configDir).length + 1))?.[1] ?? null;
}

export function parsePluginManifest(text: string): PluginManifestFields {
	let value: unknown;
	try { value = JSON.parse(text); } catch { throw new Error('Plugin manifest is not valid JSON.'); }
	if (!isRecord(value) || typeof value.id !== 'string' || !value.id
		|| !isPluginVersion(value.version) || !isPluginVersion(value.minAppVersion)) {
		throw new Error('Plugin manifest is missing its id, version or minimum app version.');
	}
	return { id: value.id, version: value.version, minAppVersion: value.minAppVersion };
}

export async function buildCrateUpdate(files: Record<CrateUpdateFile, string>): Promise<CrateUpdateBundle> {
	const manifest = parsePluginManifest(files['manifest.json']);
	const entries = await Promise.all(CRATE_UPDATE_FILES.map(async name =>
		[name, { sha256: await sha256Hex(files[name]), content: files[name] }] as const));
	return { format: CRATE_UPDATE_FORMAT, ...manifest, files: Object.fromEntries(entries) as CrateUpdateBundle['files'] };
}

/** Bundle bytes are deterministic, so devices that publish the same release write the same file. */
export const serializeCrateUpdate = (bundle: CrateUpdateBundle): string => JSON.stringify({
	format: bundle.format, id: bundle.id, version: bundle.version, minAppVersion: bundle.minAppVersion,
	files: Object.fromEntries(CRATE_UPDATE_FILES.map(name => [name, { sha256: bundle.files[name].sha256, content: bundle.files[name].content }])),
});

/** Accepts only a complete bundle for `pluginId` whose files match their hashes and whose
 * manifest agrees with the bundle's own version fields. */
export async function parseCrateUpdate(text: string, pluginId: string): Promise<CrateUpdateBundle> {
	let value: unknown;
	try { value = JSON.parse(text); } catch { throw new Error('Update file is not valid JSON.'); }
	if (!isRecord(value) || value.format !== CRATE_UPDATE_FORMAT) throw new Error('Unsupported update format.');
	if (value.id !== pluginId) throw new Error('Update belongs to another plugin.');
	if (!isPluginVersion(value.version) || !isPluginVersion(value.minAppVersion)) throw new Error('Update has an invalid version.');
	if (!isRecord(value.files)) throw new Error('Update is missing its files.');
	const files = {} as CrateUpdateBundle['files'];
	for (const name of CRATE_UPDATE_FILES) {
		const file = value.files[name];
		if (!isRecord(file) || !isSha256Hex(file.sha256) || typeof file.content !== 'string') throw new Error(`Update is missing ${name}.`);
		if (await sha256Hex(file.content) !== file.sha256) throw new Error(`Update ${name} does not match its hash.`);
		files[name] = { sha256: file.sha256, content: file.content };
	}
	const manifest = parsePluginManifest(files['manifest.json'].content);
	if (manifest.id !== pluginId || manifest.version !== value.version || manifest.minAppVersion !== value.minAppVersion) {
		throw new Error('Update manifest does not match the update.');
	}
	return { format: CRATE_UPDATE_FORMAT, id: pluginId, version: value.version, minAppVersion: value.minAppVersion, files };
}
