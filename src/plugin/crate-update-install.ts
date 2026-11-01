import type { DataAdapter } from 'obsidian';
import { sha256Hex } from '../platform/sha256';
import { isRecord, isSha256Hex } from '../platform/validation';
import {
	CRATE_UPDATE_FILES,
	buildCrateUpdate,
	compareVersions,
	crateUpdateFolder,
	crateUpdatePath,
	crateUpdateVersion,
	isPluginVersion,
	parsePluginManifest,
	serializeCrateUpdate,
	type CrateUpdateBundle,
	type CrateUpdateFile,
} from './crate-update-bundle';

export interface CrateUpdateHost {
	adapter: Pick<DataAdapter, 'exists' | 'read' | 'write' | 'remove' | 'rename' | 'mkdir' | 'rmdir' | 'list'>;
	configDir: string;
	/** Crate's own folder, `<configDir>/plugins/crate`. It never syncs. */
	pluginDir: string;
}

const stagingDir = (host: CrateUpdateHost) => `${host.pluginDir}/.update`;
const journalPath = (host: CrateUpdateHost) => `${stagingDir(host)}/install.json`;

/** The version on disk, which is newer than the running one after an install that awaits restart. */
export async function installedCrateVersion(host: CrateUpdateHost): Promise<string> {
	return parsePluginManifest(await host.adapter.read(`${host.pluginDir}/manifest.json`)).version;
}

/** Bundle versions in the synced update folder, newest first. Other files are ignored. */
export async function listCrateUpdates(host: CrateUpdateHost): Promise<string[]> {
	const folder = crateUpdateFolder(host.configDir);
	if (!await host.adapter.exists(folder)) return [];
	const { files } = await host.adapter.list(folder);
	return files.map(path => crateUpdateVersion(path, host.configDir))
		.filter((version): version is string => version !== null)
		.sort((a, b) => compareVersions(b, a));
}

/** The newest published version when it is strictly newer than the installed one. */
export async function newerCrateUpdate(host: CrateUpdateHost): Promise<string | null> {
	const [newest] = await listCrateUpdates(host);
	return newest && compareVersions(newest, await installedCrateVersion(host)) > 0 ? newest : null;
}

/**
 * Stage the bundle's files inside Crate's private folder, verify what was written,
 * then journal the install so a crash between file writes finishes on next start.
 */
export async function installCrateUpdate(host: CrateUpdateHost, bundle: CrateUpdateBundle): Promise<void> {
	await clearStaging(host);
	await host.adapter.mkdir(stagingDir(host));
	for (const name of CRATE_UPDATE_FILES) await host.adapter.write(`${stagingDir(host)}/${name}`, bundle.files[name].content);
	await readVerifiedStaging(host, Object.fromEntries(CRATE_UPDATE_FILES.map(name => [name, bundle.files[name].sha256])) as Record<CrateUpdateFile, string>);
	const journal = JSON.stringify({ format: 1, version: bundle.version, files: Object.fromEntries(CRATE_UPDATE_FILES.map(name => [name, bundle.files[name].sha256])) });
	// The journal is renamed into place, so a present journal always names fully staged files.
	await host.adapter.write(`${journalPath(host)}.tmp`, journal);
	await host.adapter.rename(`${journalPath(host)}.tmp`, journalPath(host));
	await resumeCrateUpdate(host);
}

/**
 * Finish a journaled install, rewriting each target from its verified staged copy.
 * Staging without a journal was never committed and is discarded. Returns the
 * installed version, or null when there was nothing to finish.
 */
export async function resumeCrateUpdate(host: CrateUpdateHost): Promise<string | null> {
	if (!await host.adapter.exists(stagingDir(host))) return null;
	const journal = await readJournal(host);
	if (!journal) { await clearStaging(host); return null; }
	let staged: Record<CrateUpdateFile, string>;
	try {
		staged = await readVerifiedStaging(host, journal.files);
	} catch (error) {
		await clearStaging(host);
		throw error;
	}
	for (const name of CRATE_UPDATE_FILES) await host.adapter.write(`${host.pluginDir}/${name}`, staged[name]);
	await clearStaging(host);
	return journal.version;
}

/** Publish the installed release when the vault has no bundle at least as new, and remove
 * every bundle older than the newest, which no device installs. Returns the paths it wrote or removed. */
export async function publishCrateUpdate(host: CrateUpdateHost): Promise<string[]> {
	const installed = await installedCrateVersion(host);
	const published = await listCrateUpdates(host);
	const changed: string[] = [];
	let newest = published[0];
	if (!newest || compareVersions(newest, installed) < 0) {
		const files = {} as Record<CrateUpdateFile, string>;
		for (const name of CRATE_UPDATE_FILES) files[name] = await host.adapter.read(`${host.pluginDir}/${name}`);
		const bundle = await buildCrateUpdate(files);
		// The disk can change between reads, as when Obsidian's own updater runs.
		if (bundle.version !== installed) return [];
		const folder = crateUpdateFolder(host.configDir);
		if (!await host.adapter.exists(folder)) await host.adapter.mkdir(folder);
		const path = crateUpdatePath(host.configDir, bundle.version);
		await host.adapter.write(path, serializeCrateUpdate(bundle));
		changed.push(path);
		newest = bundle.version;
	}
	for (const version of published) {
		if (version === newest) continue;
		const path = crateUpdatePath(host.configDir, version);
		await host.adapter.remove(path);
		changed.push(path);
	}
	return changed;
}

async function readVerifiedStaging(host: CrateUpdateHost, hashes: Record<CrateUpdateFile, string>): Promise<Record<CrateUpdateFile, string>> {
	const staged = {} as Record<CrateUpdateFile, string>;
	for (const name of CRATE_UPDATE_FILES) {
		const content = await host.adapter.read(`${stagingDir(host)}/${name}`);
		if (await sha256Hex(content) !== hashes[name]) throw new Error(`Staged ${name} does not match the update.`);
		staged[name] = content;
	}
	return staged;
}

async function readJournal(host: CrateUpdateHost): Promise<{ version: string; files: Record<CrateUpdateFile, string> } | null> {
	if (!await host.adapter.exists(journalPath(host))) return null;
	let value: unknown;
	try { value = JSON.parse(await host.adapter.read(journalPath(host))); } catch { return null; }
	if (!isRecord(value) || value.format !== 1 || !isPluginVersion(value.version) || !isRecord(value.files)) return null;
	const files = value.files;
	if (!CRATE_UPDATE_FILES.every(name => isSha256Hex(files[name]))) return null;
	return { version: value.version, files: files as Record<CrateUpdateFile, string> };
}

async function clearStaging(host: CrateUpdateHost): Promise<void> {
	const dir = stagingDir(host);
	if (!await host.adapter.exists(dir)) return;
	const { files } = await host.adapter.list(dir);
	for (const file of files) await host.adapter.remove(file);
	await host.adapter.rmdir(dir, false);
}
