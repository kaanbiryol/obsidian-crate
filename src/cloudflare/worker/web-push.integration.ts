/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, expect, it, vi } from 'vitest';
import { toBase64Url } from 'web-push-browser';
import { sendPushNotificationWithoutContact } from './notifications/web-push';

afterEach(() => { vi.unstubAllGlobals(); });

it.each([201, 307])('constructs a Worker-compatible push request and returns status %i', async (status) => {
	const vapidKeys = await crypto.subtle.generateKey(
		{ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
	);
	const subscriptionKeys = await crypto.subtle.generateKey(
		{ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
	);
	const endpoint = 'https://fcm.googleapis.com/push-test';
	const response = new Response(null, {
		status,
		headers: status === 307 ? { Location: 'https://redirect.invalid/' } : {},
	});
	const network = vi.fn(async (request: Request) => {
		// Keep the real Worker Request constructor: Node accepts redirect:error,
		// masking the runtime failure that originally prevented every delivery.
		expect(request).toBeInstanceOf(Request);
		expect(request.url).toBe(endpoint);
		expect(request.method).toBe('POST');
		expect(request.redirect).toBe('manual');
		expect(request.headers.get('Authorization')).toMatch(/^vapid t=/);
		expect((await request.arrayBuffer()).byteLength).toBeGreaterThan(0);
		return response;
	});
	vi.stubGlobal('fetch', network);

	const result = await sendPushNotificationWithoutContact(vapidKeys, {
		endpoint,
		keys: {
			p256dh: toBase64Url(await crypto.subtle.exportKey('raw', subscriptionKeys.publicKey)),
			auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
		},
	}, JSON.stringify({ title: 'Test' }));

	expect(result).toBe(response);
	expect(result.ok).toBe(status === 201);
	expect(network).toHaveBeenCalledOnce();
});
