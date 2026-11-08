import assert from 'node:assert/strict';
import test from 'node:test';
import { clientAddress } from '../src/local-server-http.mjs';

const request = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });

test('admits tunnel clients by the address Cloudflare forwards', () => {
	assert.equal(clientAddress(request('127.0.0.1', { 'cf-connecting-ip': '203.0.113.7' }), 'cloudflare'), '203.0.113.7');
	assert.equal(clientAddress(request('::1', { 'cf-connecting-ip': '2001:db8::7' }), 'cloudflare'), '2001:db8::7');
});

test('admits Funnel clients by the address Tailscale forwards', () => {
	assert.equal(clientAddress(request('127.0.0.1', { 'x-forwarded-for': '203.0.113.7' }), 'tailscale'), '203.0.113.7');
	assert.equal(clientAddress(request('::ffff:127.0.0.1', { 'x-forwarded-for': '2001:db8::7' }), 'tailscale'), '2001:db8::7');
});

test('trusts only the header the active tunnel sets', () => {
	// Funnel passes a client's CF-Connecting-IP through unchanged; Cloudflare passes X-Forwarded-For through.
	const spoofed = { 'cf-connecting-ip': '198.51.100.1', 'x-forwarded-for': '203.0.113.7' };
	assert.equal(clientAddress(request('127.0.0.1', spoofed), 'tailscale'), '203.0.113.7');
	assert.equal(clientAddress(request('127.0.0.1', { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.1' }), 'cloudflare'), '203.0.113.9');
	assert.equal(clientAddress(request('127.0.0.1', { 'cf-connecting-ip': '198.51.100.1' }), 'tailscale'), '127.0.0.1');
	assert.equal(clientAddress(request('127.0.0.1', { 'x-forwarded-for': '198.51.100.1' }), 'cloudflare'), '127.0.0.1');
});

test('ignores forwarded addresses without a managed tunnel or from other peers', () => {
	const forwarded = { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '203.0.113.8' };
	assert.equal(clientAddress(request('127.0.0.1', forwarded), null), '127.0.0.1');
	assert.equal(clientAddress(request('192.0.2.4', forwarded), 'cloudflare'), '192.0.2.4');
	assert.equal(clientAddress(request('192.0.2.4', forwarded), 'tailscale'), '192.0.2.4');
	assert.equal(clientAddress(request('127.0.0.1'), 'cloudflare'), '127.0.0.1');
	assert.equal(clientAddress(request('127.0.0.1'), 'tailscale'), '127.0.0.1');
});
