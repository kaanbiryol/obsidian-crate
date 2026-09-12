import { access, copyFile, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEnv } from 'vite';

export function testVaultDeployPlugin({ rootDir }) {
	return {
		name: 'crate-test-vault-deploy',
		apply: 'build',
		async writeBundle() {
			const manifestPath = path.join(rootDir, 'manifest.json');
			const manifest = await readJson(manifestPath);
			const vaultPath = resolveTestVaultPath(rootDir);
			const pluginDir = path.join(vaultPath, '.obsidian', 'plugins', manifest.id);

			await mkdir(pluginDir, { recursive: true });
			await replaceRequiredFile(path.join(rootDir, 'dist', 'main.js'), path.join(pluginDir, 'main.js'));
			await replaceRequiredFile(manifestPath, path.join(pluginDir, 'manifest.json'));
			await replaceOptionalFile(path.join(rootDir, 'dist', 'styles.css'), path.join(pluginDir, 'styles.css'));

			console.log(`Deployed ${manifest.id} to ${path.relative(rootDir, pluginDir)}`);
		},
	};
}

function resolveTestVaultPath(rootDir) {
	const configuredPath = loadEnv('development', rootDir, 'OBSIDIAN_TEST_VAULT').OBSIDIAN_TEST_VAULT?.trim();
	if (!configuredPath) {
		return path.join(rootDir, 'test-vault');
	}

	const unquotedPath = configuredPath.replace(/^['"]|['"]$/g, '');
	const expandedPath = unquotedPath === '~'
		? os.homedir()
		: unquotedPath.startsWith('~/')
			? path.join(os.homedir(), unquotedPath.slice(2))
			: unquotedPath;

	return path.resolve(rootDir, expandedPath);
}

async function replaceRequiredFile(sourcePath, destinationPath) {
	await access(sourcePath, constants.F_OK);
	await replaceFile(sourcePath, destinationPath);
}

async function replaceOptionalFile(sourcePath, destinationPath) {
	try {
		await access(sourcePath, constants.F_OK);
	} catch {
		return;
	}

	await replaceFile(sourcePath, destinationPath);
}

async function replaceFile(sourcePath, destinationPath) {
	const tempPath = path.join(
		path.dirname(destinationPath),
		`.${path.basename(destinationPath)}.${process.pid}.${Date.now()}.tmp`,
	);

	try {
		await copyFile(sourcePath, tempPath);
		await rename(tempPath, destinationPath);
	} catch (error) {
		await rm(tempPath, { force: true });
		throw error;
	}
}

async function readJson(filePath) {
	const contents = await readFile(filePath, 'utf8');
	const parsed = JSON.parse(contents);

	if (!parsed || typeof parsed.id !== 'string' || parsed.id.length === 0) {
		throw new Error(`Expected a plugin id in ${filePath}`);
	}

	return parsed;
}
