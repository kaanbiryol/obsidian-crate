import { execFileSync } from 'node:child_process';
import { rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

// Ignored build and test output, including every visual run left behind by failures.
export const cleanTargets = ['dist', '.generated/visual-runs', 'playwright-report', 'test-results'];

function git(root, args) {
	try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return undefined; }
}

export async function clean(root = resolve(import.meta.dirname, '..'), targets = cleanTargets) {
	const removed = [];
	for (const target of targets) {
		if (!(await stat(resolve(root, target)).catch(() => undefined))) continue;
		// Never delete source: a target must be ignored by Git and hold no tracked file.
		if (git(root, ['check-ignore', '--quiet', target]) === undefined || git(root, ['ls-files', '--', target]) !== '') {
			throw new Error(`Refusing to remove ${target}: it is not ignored by Git or contains tracked files.`);
		}
		await rm(resolve(root, target), { recursive: true, force: true });
		removed.push(target);
	}
	return removed;
}

if (import.meta.main) {
	try {
		const removed = await clean();
		console.log(removed.length ? `Removed ${removed.join(', ')}` : 'Nothing to clean.');
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
