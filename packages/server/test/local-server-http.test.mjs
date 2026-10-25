import assert from 'node:assert/strict';
import test from 'node:test';
import { clientAddress } from '../src/local-server-http.mjs';

const request = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });

test('admits tunnel clients by the address Cloudflare forwards', () => {
	assert.equal(clientAddress(request('127.0.0.1', { 'cf-connecting-ip': '203.0.113.7' }), true), '203.0.113.7');
	assert.equal(clientAddress(request('::1', { 'cf-connecting-ip': '2001:db8::7' }), true), '2001:db8::7');
});

test('ignores forwarded addresses without a managed tunnel or from other peers', () => {
	assert.equal(clientAddress(request('127.0.0.1', { 'cf-connecting-ip': '203.0.113.7' }), false), '127.0.0.1');
	assert.equal(clientAddress(request('192.0.2.4', { 'cf-connecting-ip': '203.0.113.7' }), true), '192.0.2.4');
	assert.equal(clientAddress(request('127.0.0.1'), true), '127.0.0.1');
});
