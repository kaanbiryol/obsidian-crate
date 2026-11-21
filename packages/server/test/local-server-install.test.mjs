import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crateCommand, installKind } from '../src/local-server-install.mjs';
import { pairingLink, terminalQr } from '../src/local-server-qr.mjs';

test('names the install from Docker, the package marker and the npx cache', () => {
	assert.equal(installKind({ docker: true, packaged: true }), 'docker');
	assert.equal(installKind({ docker: false, packaged: false }), 'source');
	assert.equal(installKind({ docker: false, packaged: true, script: '/Users/me/.npm/_npx/0123/node_modules/@kaanbiryol/crate-server/scripts/crate-server.mjs' }), 'npx');
	assert.equal(installKind({ docker: false, packaged: true, script: '/opt/homebrew/lib/node_modules/@kaanbiryol/crate-server/scripts/crate-server.mjs' }), 'npm');
});

test('prints each install its own command', () => {
	assert.equal(crateCommand('docker', 'pair'), 'docker compose exec crate crate pair');
	assert.equal(crateCommand('source', 'pair'), 'npm run server -- pair');
	assert.equal(crateCommand('npx', 'pair'), 'npx @kaanbiryol/crate-server pair');
	assert.equal(crateCommand('npm', 'pair'), 'crate-server pair');
});

test('keeps the pairing code in the link fragment and draws a square QR code', () => {
	const code = `crate-pair-${'a'.repeat(64)}`;
	assert.equal(pairingLink('https://crate.tail1234.ts.net/', code), `https://crate.tail1234.ts.net/notifications/pair#${code}`);
	const lines = terminalQr(pairingLink('https://crate.tail1234.ts.net', code)).split('\n');
	assert.ok(lines.length > 10);
	assert.ok(lines.every(line => line.length === lines[0].length));
	assert.match(lines[0], /^█+$/);
});
