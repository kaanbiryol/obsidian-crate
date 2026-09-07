import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'fixtures/test-vault');
const destination = path.join(root, 'test-vault');
const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--reset')) {
	throw new Error('Usage: npm run vault:setup -- [--reset]');
}
const reset = args.includes('--reset');
let copied = 0;
let skipped = 0;

async function rejectSymlink(target) {
	try {
		if ((await lstat(target)).isSymbolicLink()) {
			throw new Error(`Refusing to write through symlink: ${target}`);
		}
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
	}
}

async function seed(relative = '') {
	const directory = path.join(destination, relative);
	await rejectSymlink(directory);
	await mkdir(directory, { recursive: true });
	for (const entry of await readdir(path.join(source, relative), { withFileTypes: true })) {
		if (entry.name.startsWith('.')) continue;
		const child = path.join(relative, entry.name);
		if (entry.isDirectory()) {
			await seed(child);
		} else if (entry.isFile() && entry.name.endsWith('.md')) {
			const target = path.join(destination, child);
			await rejectSymlink(target);
			try {
				await copyFile(path.join(source, child), target, reset ? 0 : constants.COPYFILE_EXCL);
				copied++;
			} catch (error) {
				if (error.code !== 'EEXIST' || reset) throw error;
				skipped++;
			}
		}
	}
}

await seed();
console.log(`Test vault: copied ${copied} notes, kept ${skipped} existing notes.`);
