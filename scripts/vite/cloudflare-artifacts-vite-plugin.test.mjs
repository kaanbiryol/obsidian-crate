import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { cloudflareArtifactsPlugin } from './cloudflare-artifacts-vite-plugin.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');

test('requires verified SQL for supported migrations and lets retired SQL leave the bundle', t => {
	const root = mkdtempSync(join(tmpdir(), 'crate-artifacts-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const write = (path, text) => {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	};
	const load = release => {
		write('src/cloudflare/server-release.json', JSON.stringify(release));
		write('.generated/cloudflare/build-identity.json', JSON.stringify({ workerSha256: sha256('worker'), release }));
		return cloudflareArtifactsPlugin({ rootDir: root }).load('\0virtual:crate-cloudflare-artifacts');
	};
	write('package.json', JSON.stringify({ version: '0.1.0' }));
	write('.generated/cloudflare/worker.mjs', 'worker');
	write('src/cloudflare/schema.sql', 'CREATE TABLE example(id TEXT);');
	const sql = 'ALTER TABLE example ADD title TEXT;';
	const supported = { revision: 2, schemaVersion: 2, minimumSchemaVersion: 1, migrations: [{ id: 'example', from: 1, to: 2, file: 'example.sql', checksum: sha256(sql) }] };
	const retired = { ...supported, minimumSchemaVersion: 2 };

	assert.throws(() => load(supported), /ENOENT/);
	write('src/cloudflare/migrations/example.sql', sql);
	assert.match(load(supported), /artifactFingerprint/);
	// A retired file that is still present must keep its released bytes.
	write('src/cloudflare/migrations/example.sql', `${sql} `);
	assert.throws(() => load(retired), /Invalid database migration artifact/);
	rmSync(join(root, 'src/cloudflare/migrations/example.sql'));
	assert.match(load(retired), /artifactFingerprint/);
});
