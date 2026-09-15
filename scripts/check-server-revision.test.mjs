import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkServerRevision, revisionBase } from './check-server-revision.mjs';
import { collectServerInputs } from './server-build-inputs.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'crate-server-revision-'));
	roots.push(root);
	const write = (path, value) => {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value));
	};
	const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	git('init', '-b', 'main');
	git('config', 'user.name', 'Test');
	git('config', 'user.email', 'test@example.invalid');
	const commit = () => { git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-m', 'chore: fixture'); return git('rev-parse', 'HEAD'); };
	const release = (overrides = {}) => write('src/cloudflare/server-release.json', { revision: 1, schemaVersion: 1, minimumSchemaVersion: 1, migrations: [], ...overrides });
	release();
	write('src/cloudflare/schema.sql', 'CREATE TABLE example(id TEXT);');
	write('src/shared.ts', 'export const value = 1;');
	write('package.json', { name: 'crate', version: '0.1.0' });
	write('package-lock.json', { name: 'crate', version: '0.1.0', packages: { '': { name: 'crate', version: '0.1.0' } } });
	const base = commit();
	const inputs = ['src/shared.ts', 'src/cloudflare/server-release.json', 'src/cloudflare/schema.sql'];
	const check = () => checkServerRevision(root, base, inputs);
	const ci = (name, event, extra = {}) => {
		write('.event.json', event);
		return revisionBase(root, { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: name, GITHUB_EVENT_PATH: join(root, '.event.json'), ...extra });
	};
	return { root, write, git, commit, release, base, inputs, check, ci };
}

test('requires a revision for reachable shared code, including untracked additions', () => {
	const h = fixture();
	h.write('src/shared.ts', 'export const value = 2;');
	assert.throws(h.check, /without increasing revision/);
	h.release({ revision: 2 });
	assert.ok(h.check().changed.includes('src/shared.ts'));
	h.commit();
	h.write('src/new.ts', 'export const enabled = true;');
	assert.throws(() => checkServerRevision(h.root, 'HEAD', [...h.inputs, 'src/new.ts']), /src\/new.ts/);
});

test('allows unrelated plugin, test, docs and package version changes', () => {
	const h = fixture();
	h.write('src/plugin/example.ts', 'export const version = 2;');
	h.write('src/shared.test.ts', 'test');
	h.write('docs/example.md', 'documentation');
	h.write('package.json', { name: 'crate', version: '0.2.0' });
	h.write('package-lock.json', { name: 'crate', version: '0.2.0', packages: { '': { name: 'crate', version: '0.2.0' } } });
	assert.deepEqual(h.check().changed, []);
});

test('catches dependency and build configuration changes even outside the source graph', () => {
	const h = fixture();
	h.write('package-lock.json', { packages: { 'node_modules/example': { version: '2.0.0' } } });
	assert.throws(h.check, /package-lock.json/);
	h.write('package.json', { scripts: { 'build:worker': 'node replacement.mjs' } });
	assert.throws(h.check, /package.json/);
});

test('rejects downgraded revisions and schema edits without a new schema version', () => {
	const h = fixture();
	h.release({ revision: 3 });
	const base = h.commit();
	h.release({ revision: 2 });
	assert.throws(() => checkServerRevision(h.root, base, h.inputs), /cannot decrease/);
	h.write('src/cloudflare/schema.sql', 'CREATE TABLE example(id TEXT, title TEXT);');
	assert.throws(h.check, /schemaVersion increase/);
});

test('never permits editing or deleting an already released migration', () => {
	const h = fixture();
	const migrations = [{ id: 'example', file: 'example.sql', from: 1, to: 2, checksum: 'a'.repeat(64) }];
	h.write('src/cloudflare/migrations/example.sql', 'ALTER TABLE example ADD title TEXT;');
	h.release({ revision: 2, schemaVersion: 2, migrations });
	const base = h.commit();
	h.release({ revision: 3, schemaVersion: 2, migrations });
	h.write('src/cloudflare/migrations/example.sql', 'ALTER TABLE example ADD name TEXT;');
	assert.throws(() => checkServerRevision(h.root, base, h.inputs), /cannot be edited or removed/);
	h.release({ revision: 3, schemaVersion: 2 });
	assert.throws(() => checkServerRevision(h.root, base, h.inputs), /cannot be edited or removed/);
});

test('recognizes the initial manifest without silently accepting a missing Git baseline', () => {
	const h = fixture();
	h.git('rm', 'src/cloudflare/server-release.json');
	const base = h.commit();
	h.release();
	assert.equal(checkServerRevision(h.root, base, h.inputs).bootstrap, true);
	assert.throws(() => revisionBase(h.root, {}, 'missing-ref'));
	assert.equal(revisionBase(h.root, {}), base);
});

test('checks an entire multi-commit PR and push, including when the last commit changes only docs', () => {
	const h = fixture();
	h.write('src/shared.ts', 'export const value = 2;');
	h.commit();
	h.write('docs/readme.md', 'docs');
	h.commit();
	assert.equal(h.ci('pull_request', { pull_request: { base: { sha: h.base } } }), h.base);
	assert.equal(h.ci('push', { ref: 'refs/heads/main', before: h.base }), h.base);
	assert.throws(() => checkServerRevision(h.root, h.ci('pull_request', { pull_request: { base: { sha: h.base } } }), h.inputs), /without increasing revision/);
});

test('uses the default branch for a first branch push and previous release for tags and manual releases', () => {
	const h = fixture();
	h.git('tag', '0.1.0');
	h.git('update-ref', 'refs/remotes/origin/main', h.base);
	h.write('src/shared.ts', 'export const value = 2;');
	h.commit();
	h.write('docs/readme.md', 'docs');
	h.commit();
	assert.equal(h.ci('push', { ref: 'refs/heads/feature', before: '0'.repeat(40), repository: { default_branch: 'main' } }), h.base);
	assert.equal(h.ci('push', { ref: 'refs/tags/0.2.0' }), h.base);
	assert.equal(h.ci('workflow_dispatch', {}, { RELEASE_TAG: '0.2.0' }), h.base);
	assert.throws(() => h.ci('unknown', {}), /No server revision baseline/);
});

test('collects transitive deployment/build imports plus runtime graph and raw Sass files', async () => {
	const h = fixture();
	h.write('src/cloudflare/provisioner.ts', 'import "../shared.ts";');
	h.write('src/cloudflare/deployment-recovery.ts', 'export const recovery = true;');
	h.write('src/cloudflare/server-delete.ts', 'export const deletion = true;');
	h.write('scripts/build-worker.mjs', 'import "./helper.mjs";');
	h.write('scripts/helper.mjs', 'export const config = true;');
	h.write('scripts/cloudflare-artifacts-vite-plugin.mjs', 'export const artifacts = true;');
	const inputs = await collectServerInputs(h.root, [{ inputs: { 'src/pwa/main.tsx': {}, 'src/reminders/shared.ts': {}, 'node_modules/dependency/index.js': {}, '<define:assets>': {} } }], new Set([join(h.root, 'src/styles/shared.scss')]));
	for (const file of ['src/shared.ts', 'scripts/helper.mjs', 'src/pwa/main.tsx', 'src/reminders/shared.ts', 'src/styles/shared.scss']) assert.ok(inputs.includes(file), file);
	assert.ok(!inputs.some(path => path.startsWith('node_modules/') || path.startsWith('<')));
});
