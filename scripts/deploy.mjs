import { access, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';

const rootDir = process.cwd();
const manifestPath = path.join(rootDir, 'manifest.json');
const configPath = path.join(rootDir, 'deploy.local.json');
const buildMainPath = path.join(rootDir, 'dist', 'main.js');
const buildStylesPath = path.join(rootDir, 'dist', 'styles.css');
const args = new Set(process.argv.slice(2));
const configureOnly = args.has('--configure');

async function main() {
	const manifest = await readJson(manifestPath, 'manifest.json');
	const config = configureOnly ? await promptForConfig() : await getDeployConfig();
	const pluginDir = path.join(config.vaultPath, '.obsidian', 'plugins', manifest.id);

	if (configureOnly) {
		console.log(`Saved deploy config to ${relativeToRoot(configPath)}`);
		console.log(`Vault path: ${config.vaultPath}`);
		return;
	}

	await runBuild();
	await mkdir(pluginDir, { recursive: true });
	await copyRequiredFile(buildMainPath, path.join(pluginDir, 'main.js'));
	await copyRequiredFile(manifestPath, path.join(pluginDir, 'manifest.json'));
	await copyOptionalFile(buildStylesPath, path.join(pluginDir, 'styles.css'));

	console.log(`Deployed ${manifest.id} to ${pluginDir}`);
}

async function getDeployConfig() {
	const savedConfig = await loadSavedConfig();
	if (savedConfig) {
		return savedConfig;
	}

	const envVaultPath = process.env.OBSIDIAN_VAULT?.trim();
	if (envVaultPath) {
		return resolveConfig({ vaultPath: envVaultPath }, 'OBSIDIAN_VAULT');
	}

	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		throw new Error(
			`Missing ${relativeToRoot(configPath)}. Run "npm run deploy:configure" or set OBSIDIAN_VAULT.`,
		);
	}

	console.log(`No ${relativeToRoot(configPath)} found. Let's create one.`);
	return promptForConfig();
}

async function loadSavedConfig() {
	try {
		await access(configPath, constants.F_OK);
	} catch {
		return null;
	}

	const config = await readJson(configPath, relativeToRoot(configPath));
	return resolveConfig(config, relativeToRoot(configPath));
}

async function promptForConfig() {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	try {
		const answer = await rl.question('Enter the absolute path to your Obsidian vault: ');
		const config = await resolveConfig({ vaultPath: answer }, 'deploy.local.json');
		await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
		return config;
	} finally {
		rl.close();
	}
}

async function runBuild() {
	await new Promise((resolve, reject) => {
		const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
		const child = spawn(npmCommand, ['run', 'build'], {
			cwd: rootDir,
			stdio: 'inherit',
		});

		child.on('exit', (code) => {
			if (code === 0) {
				resolve();
				return;
			}

			reject(new Error(`npm run build failed with exit code ${code ?? 'unknown'}`));
		});

		child.on('error', reject);
	});
}

async function copyRequiredFile(sourcePath, destinationPath) {
	await ensureFileExists(sourcePath);
	await replaceFile(sourcePath, destinationPath);
}

async function copyOptionalFile(sourcePath, destinationPath) {
	try {
		await ensureFileExists(sourcePath);
	} catch {
		return;
	}

	await replaceFile(sourcePath, destinationPath);
}

async function replaceFile(sourcePath, destinationPath) {
	const destinationDir = path.dirname(destinationPath);
	const tempPath = path.join(
		destinationDir,
		`.${path.basename(destinationPath)}.${process.pid}.${Date.now()}.tmp`,
	);

	try {
		await copyFile(sourcePath, tempPath);
		await rename(tempPath, destinationPath);
	} catch (error) {
		await rm(tempPath, { force: true });
		if (isPermissionError(error)) {
			throw new Error(
				[
					`macOS refused to replace ${destinationPath}.`,
					'If this file is inside an iCloud-backed Obsidian vault, remove the existing plugin folder in Finder',
					'or grant Full Disk Access to your terminal app, then run "npm run deploy" again.',
				].join(' '),
				{ cause: error },
			);
		}
		throw error;
	}
}

function isPermissionError(error) {
	return error && typeof error === 'object' && 'code' in error && error.code === 'EPERM';
}

async function ensureFileExists(filePath) {
	try {
		await access(filePath, constants.F_OK);
	} catch {
		throw new Error(`Expected file not found: ${relativeToRoot(filePath)}`);
	}
}

async function readJson(filePath, label) {
	const contents = await readFile(filePath, 'utf8');

	try {
		return JSON.parse(contents);
	} catch (error) {
		throw new Error(`Could not parse ${label}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function validateConfig(config, sourceLabel) {
	if (!config || typeof config !== 'object') {
		throw new Error(`Invalid deploy config in ${sourceLabel}`);
	}

	if (typeof config.vaultPath !== 'string' || config.vaultPath.trim().length === 0) {
		throw new Error(`Expected "vaultPath" to be a non-empty string in ${sourceLabel}`);
	}

	return {
		vaultPath: normalizeVaultPath(config.vaultPath),
	};
}

async function resolveConfig(config, sourceLabel) {
	const normalizedConfig = validateConfig(config, sourceLabel);
	await ensureDirectoryExists(normalizedConfig.vaultPath, sourceLabel);
	return normalizedConfig;
}

function normalizeVaultPath(rawPath) {
	const trimmedPath = rawPath.trim().replace(/^['"]|['"]$/g, '');
	const expandedPath = trimmedPath === '~'
		? os.homedir()
		: trimmedPath.startsWith('~/')
			? path.join(os.homedir(), trimmedPath.slice(2))
			: trimmedPath;

	return path.resolve(expandedPath);
}

function relativeToRoot(targetPath) {
	return path.relative(rootDir, targetPath) || targetPath;
}

async function ensureDirectoryExists(directoryPath, sourceLabel) {
	let directoryStat;

	try {
		directoryStat = await stat(directoryPath);
	} catch {
		throw new Error(`Vault path from ${sourceLabel} does not exist: ${directoryPath}`);
	}

	if (!directoryStat.isDirectory()) {
		throw new Error(`Vault path from ${sourceLabel} is not a directory: ${directoryPath}`);
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
