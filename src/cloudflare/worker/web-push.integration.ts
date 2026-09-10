/// <reference types="@cloudflare/vitest-plugin/types" />
import { createDecipheriv, hkdfSync } from 'node:crypto';
import { Buffer } from 'node:buffer';
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

it.each(['x', '漢', '🙂', '"\n'])('delivers a maximum-size reminder with %s display text in a 4096-byte encrypted message', async character => {
	const { createDeclarativePushPayload } = await import('./notifications/push');
	const title = character.repeat(1024 / character.length);
	const project = '漢'.repeat(80);
	const reminderId = 'e1_00020000_' + 'a'.repeat(100);
	const payload = createDeclarativePushPayload({ title, body: project, project, reminderId, tag: reminderId }, 'https://worker.test');
	expect(payload.notification.navigate).toBe(`https://worker.test/notifications?reminderId=${reminderId}`);
	expect(JSON.stringify(payload)).not.toContain('�');
	const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
	const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
	const network = vi.fn(async (request: Request) => {
		expect((await request.arrayBuffer()).byteLength).toBeLessThanOrEqual(4096);
		return new Response(null, { status: 201 });
	});
	vi.stubGlobal('fetch', network);
	expect((await sendPushNotificationWithoutContact(vapid, { endpoint: 'https://fcm.googleapis.com/push-test', keys: {
		p256dh: toBase64Url(await crypto.subtle.exportKey('raw', keys.publicKey)), auth: toBase64Url(new Uint8Array(16)),
	} }, JSON.stringify(payload))).status).toBe(201);
	expect(network).toHaveBeenCalledOnce();
});


it('encrypts a notification that an independent receiver can authenticate and decrypt', async () => {
	const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
	const receiver = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
	const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', receiver.publicKey));
	const auth = crypto.getRandomValues(new Uint8Array(16));
	const payload = JSON.stringify({ title: 'Reminder 🙂', body: 'Review release notes' });
	vi.stubGlobal('fetch', vi.fn(async (request: Request) => {
		const record = Buffer.from(await request.arrayBuffer());
		const salt = record.subarray(0, 16);
		const senderPublicKey = record.subarray(21, 21 + record[20]!);
		const ciphertext = record.subarray(21 + record[20]!);
		const senderKey = await crypto.subtle.importKey('raw', senderPublicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
		const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: senderKey }, receiver.privateKey, 256);
		const ikm = hkdfSync('sha256', Buffer.from(shared), auth,
			Buffer.concat([Buffer.from('WebPush: info\0'), publicKey, senderPublicKey]), 32);
		const key = hkdfSync('sha256', Buffer.from(ikm), salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
		const nonce = hkdfSync('sha256', Buffer.from(ikm), salt, Buffer.from('Content-Encoding: nonce\0'), 12);
		const decipher = createDecipheriv('aes-128-gcm', Buffer.from(key), Buffer.from(nonce));
		decipher.setAuthTag(ciphertext.subarray(-16));
		const plaintext = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
		expect(plaintext.at(-1)).toBe(2);
		expect(plaintext.subarray(0, -1).toString()).toBe(payload);
		expect(request.redirect).toBe('manual');
		expect(request.signal).toBeDefined();
		return new Response(null, { status: 201 });
	}));
	await sendPushNotificationWithoutContact(vapid, {
		endpoint: 'https://web.push.apple.com/test',
		keys: { p256dh: toBase64Url(publicKey), auth: toBase64Url(auth) },
	}, payload);
});
