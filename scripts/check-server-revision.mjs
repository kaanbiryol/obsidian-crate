import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const releasePath = 'src/cloudflare/server-release.json';
const schemaPath = 'src/cloudflare/schema.sql';
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
const commit = (root, ref) => git(root, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`);

/** CI must compare the complete change, not just the tip commit of a PR/push. */
export function revisionBase(root, env = process.env, explicit) {
	if (explicit) return commit(root, explicit);
	if (env.GITHUB_ACTIONS !== 'true') return commit(root, 'HEAD');
	const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
	if (env.GITHUB_EVENT_NAME === 'pull_request') {
		return git(root, 'merge-base', 'HEAD', commit(root, event.pull_request.base.sha));
	}
	if (env.GITHUB_EVENT_NAME === 'push' && event.ref?.startsWith('refs/heads/')) {
		if (event.before && !/^0+$/.test(event.before)) return commit(root, event.before);
		// The first push of a branch has no "before" commit.
		const branch = event.repository?.default_branch;
		if (branch) {
			const base = git(root, 'merge-base', 'HEAD', commit(root, `refs/remotes/origin/${branch}`));
			if (base !== commit(root, 'HEAD')) return base;
		}
	} else if (!(env.GITHUB_EVENT_NAME === 'push' && event.ref?.startsWith('refs/tags/'))
		&& !(env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.RELEASE_TAG)) {
		throw new Error('No server revision baseline for this CI event; supply --base explicitly.');
	}
	const parents = git(root, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').slice(1);
	if (!parents.length) return commit(root, 'HEAD'); // First repository commit.
	// Releases also catch changes accumulated since the previous release tag.
	if (event.ref?.startsWith('refs/tags/') || env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
		const tags = git(root, 'tag', '--merged', parents[0], '--sort=-version:refname').split('\n');
		const previous = tags.find(tag => /^\d+\.\d+\.\d+$/.test(tag));
		if (previous) return commit(root, previous);
	}
	return parents[0];
}

function manifest(text) {
	const value = JSON.parse(text);
	if (!['revision', 'schemaVersion', 'minimumSchemaVersion'].every(key => Number.isSafeInteger(value[key]) && value[key] > 0)
		|| !Array.isArray(value.migrations)) throw new Error('Invalid server release manifest');
	for (const migration of value.migrations) {
		if (!/^[a-z0-9-]+\.sql$/.test(migration.file)) throw new Error('Invalid migration filename');
	}
	return value;
}

function packageInputs(text, lock) {
	const value = JSON.parse(text);
	if (lock) {
		delete value.name;
		delete value.version;
		if (value.packages?.['']) {
			delete value.packages[''].name;
			delete value.packages[''].version;
		}
		return value;
	}
	// Package versions and descriptive metadata do not change server artifacts.
	const { type, engines, dependencies, devDependencies, overrides, scripts } = value;
	return { type, engines, dependencies, devDependencies, overrides,
		scripts: Object.fromEntries(Object.entries(scripts ?? {}).filter(([name]) => /^(build|version)(:|$)/.test(name))) };
}

export function checkServerRevision(root, base, inputs) {
	base = commit(root, base);
	const previousFiles = new Map(git(root, 'ls-tree', '-r', '-z', base).split('\0').filter(Boolean).map(line => {
		const [entry, path] = line.split('\t');
		return [path, entry.split(' ')[2]];
	}));
	const read = path => readFileSync(resolve(root, path));
	const current = manifest(read(releasePath));
	if (!previousFiles.has(releasePath)) return { baseline: base, revision: current.revision, bootstrap: true, changed: [] };
	const before = manifest(git(root, 'show', `${base}:${releasePath}`));
	if (current.revision < before.revision) throw new Error('Server revision cannot decrease.');
	if (current.schemaVersion < before.schemaVersion) throw new Error('Database schema version cannot decrease.');
	const algorithm = git(root, 'rev-parse', '--show-object-format');
	const changed = path => {
		let contents;
		try { contents = read(path); }
		catch (error) { if (error.code === 'ENOENT') return previousFiles.has(path); throw error; }
		const hash = createHash(algorithm).update(`blob ${contents.length}\0`).update(contents).digest('hex');
		return hash !== previousFiles.get(path);
	};
	if (changed(schemaPath) && current.schemaVersion <= before.schemaVersion) {
		throw new Error('schema.sql changed without a schemaVersion increase and migration plan.');
	}
	for (const [index, migration] of before.migrations.entries()) {
		if (JSON.stringify(migration) !== JSON.stringify(current.migrations[index]) || changed(`src/cloudflare/migrations/${migration.file}`)) {
			throw new Error(`Released migration ${migration.id} cannot be edited or removed.`);
		}
	}
	const changedPaths = inputs.filter(changed);
	for (const path of ['package.json', 'package-lock.json']) {
		if (!previousFiles.has(path) || JSON.stringify(packageInputs(read(path), path.endsWith('-lock.json')))
			!== JSON.stringify(packageInputs(git(root, 'show', `${base}:${path}`), path.endsWith('-lock.json')))) changedPaths.push(path);
	}
	if (changedPaths.length && current.revision <= before.revision) {
		throw new Error(`Server inputs changed without increasing revision in ${releasePath}:\n${changedPaths.map(path => `  ${path}`).join('\n')}`);
	}
	return { baseline: base, revision: current.revision, bootstrap: false, changed: changedPaths };
}

if (import.meta.main) {
	try {
		const args = process.argv.slice(2);
		if (args.length && (args.length !== 2 || args[0] !== '--base')) throw new Error('Usage: npm run check:server-revision -- --base <git-ref>');
		const root = resolve(import.meta.dirname, '..');
		const base = revisionBase(root, process.env, args[1]);
		const inputs = JSON.parse(readFileSync(resolve(root, '.generated/cloudflare/server-inputs.json'), 'utf8'));
		const result = checkServerRevision(root, base, inputs);
		console.log(`Server revision ${result.revision} verified against ${base.slice(0, 12)} (${result.bootstrap ? 'first release manifest' : `${result.changed.length} changed server inputs`}).`);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
