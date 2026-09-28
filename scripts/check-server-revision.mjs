import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const releasePath = 'src/cloudflare/server-release.json';
const schemaPath = 'src/cloudflare/schema.sql';
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
const commit = (root, ref) => git(root, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`);

/** Published releases, rather than development commits, define the revision baseline. */
export function revisionBase(root, env = process.env, explicit) {
  if (explicit) return commit(root, explicit);
  const event = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const releaseRun = Boolean(env.RELEASE_TAG) || event.ref?.startsWith('refs/tags/');
  const head = commit(root, 'HEAD');
  let baseline;
  try {
    const policy = JSON.parse(readFileSync(resolve(root, 'scripts/server-release-policy.json'), 'utf8'));
    if (!/^[a-f0-9]{40}$/.test(policy.baselineCommit)) throw new Error('Invalid server release baseline');
    baseline = commit(root, policy.baselineCommit);
    if (git(root, 'merge-base', head, baseline) !== baseline) throw new Error('Server release baseline is not an ancestor of HEAD');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const releases = env.CRATE_PUBLISHED_RELEASES !== undefined ? JSON.parse(env.CRATE_PUBLISHED_RELEASES)
    : JSON.parse(execFileSync('gh', ['release', 'list', '--limit', '1000', '--json', 'tagName,isDraft'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const published = new Set(releases.filter(release => !release.isDraft).map(release => release.tagName));
  const tags = git(root, 'tag', '--merged', 'HEAD', '--sort=-version:refname').split('\n').filter(tag => published.has(tag) && (!baseline || git(root, 'merge-base', baseline, commit(root, tag)) === baseline));
  const previous = tags.find(tag => /^\d+\.\d+\.\d+$/.test(tag) && (!releaseRun || commit(root, tag) !== head));
  if (previous) return commit(root, previous);
  if (baseline) return baseline;
  // Before the first release, freeze the earliest manifest as the development baseline.
  const introductions = git(root, 'log', '--reverse', '--format=%H', '--diff-filter=A', 'HEAD', '--', releasePath).split('\n').filter(Boolean);
  return introductions[0] ?? head;
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
  // The pinned pre-launch commit is a source/schema baseline, not a published release.
  let initialRevision;
  try {
    const policy = JSON.parse(readFileSync(resolve(root, 'scripts/server-release-policy.json'), 'utf8'));
    if (policy.baselineCommit === base && policy.initialRevision !== undefined) {
      if (policy.initialRevision !== 1) throw new Error('The initial public server revision must be 1.');
      initialRevision = policy.initialRevision;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (initialRevision !== undefined) {
    if (current.revision !== initialRevision) throw new Error('The first public server release must use revision 1.');
    before.revision = 0;
  }
	if (current.revision < before.revision) throw new Error('Server revision cannot decrease.');
	const launchReset = before.baselineSchemaVersion === 4 && before.schemaVersion === 4
		&& before.minimumSchemaVersion === 4 && before.migrations.length === 0
		&& current.baselineSchemaVersion === undefined && current.schemaVersion === 1
		&& current.minimumSchemaVersion === 1 && current.migrations.length === 0 && current.revision > before.revision;
	if (!launchReset && current.schemaVersion < before.schemaVersion) throw new Error('Database schema version cannot decrease.');
	const algorithm = git(root, 'rev-parse', '--show-object-format');
	const changed = path => {
		let contents;
		try { contents = read(path); }
		catch (error) { if (error.code === 'ENOENT') return previousFiles.has(path); throw error; }
		const hash = createHash(algorithm).update(`blob ${contents.length}\0`).update(contents).digest('hex');
		return hash !== previousFiles.get(path);
	};
	if (!launchReset && changed(schemaPath) && current.schemaVersion <= before.schemaVersion) {
		throw new Error('schema.sql changed without a schemaVersion increase and migration plan.');
	}
	for (const migration of before.migrations) {
		if (JSON.stringify(migration) !== JSON.stringify(current.migrations.find(step => step.id === migration.id)) || changed(`src/cloudflare/migrations/${migration.file}`)) {
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
	if (current.revision > before.revision + 1) throw new Error('Public server revision must advance by exactly one from the release baseline.');
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
