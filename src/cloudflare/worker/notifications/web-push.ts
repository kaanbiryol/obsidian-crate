import { isValidPushEndpoint } from './push-endpoint';
import { fromBase64Url, toBase64Url } from 'web-push-browser';

const PUSH_RECORD_SIZE = 4096;
const VAPID_TOKEN_LIFETIME_SECONDS = 12 * 60 * 60;

interface WebPushSubscription {
	endpoint: string;
	keys: {
		p256dh: string;
		auth: string;
	};
}

/**
 * Creates a VAPID token without a `sub` claim. The claim is optional, and
 * Crate has no appropriate shared contact because each deployment is owned by
 * a different Cloudflare account.
 */
export async function createVapidAuthorizationToken(
	privateKey: CryptoKey,
	endpoint: URL,
): Promise<string> {
	const encodedHeader = toBase64Url(JSON.stringify({ alg: 'ES256', typ: 'JWT' }));
	const encodedPayload = toBase64Url(JSON.stringify({
		aud: endpoint.origin,
		exp: Math.floor(Date.now() / 1000) + VAPID_TOKEN_LIFETIME_SECONDS,
	}));
	const signingInput = `${encodedHeader}.${encodedPayload}`;
	const signature = await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' },
		privateKey,
		new TextEncoder().encode(signingInput),
	);

	return `${signingInput}.${toBase64Url(signature)}`;
}

export async function sendPushNotificationWithoutContact(
	vapidKeys: CryptoKeyPair,
	subscription: WebPushSubscription,
	payload: string,
): Promise<Response> {
	if (!isValidPushEndpoint(subscription.endpoint)) throw new Error('Push service is not supported');
	const [jwt, encryptedPayload, exportedPublicKey] = await Promise.all([
		createVapidAuthorizationToken(vapidKeys.privateKey, new URL(subscription.endpoint)),
		encryptPayload(payload, subscription.keys),
		crypto.subtle.exportKey('raw', vapidKeys.publicKey),
	]);
	const headers = new Headers({
		'Content-Type': 'application/octet-stream',
		'Content-Length': String(encryptedPayload.byteLength),
		TTL: '86400',
		Authorization: `vapid t=${jwt}, k=${toBase64Url(exportedPublicKey)}`,
		'Content-Encoding': 'aes128gcm',
	});

	return fetch(new Request(subscription.endpoint, {
		method: 'POST',
		// Workers only support follow/manual. Return redirects to the caller's
		// failure handling without forwarding the payload or VAPID credentials.
		redirect: 'manual',
		signal: AbortSignal.timeout(10_000),
		headers,
		body: encryptedPayload,
	}));
}

async function encryptPayload(
	payload: string,
	subscriptionKeys: WebPushSubscription['keys'],
): Promise<Uint8Array> {
	const userAgentPublicKey = new Uint8Array(fromBase64Url(subscriptionKeys.p256dh));
	const authSecret = new Uint8Array(fromBase64Url(subscriptionKeys.auth));
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const ephemeralKeyPair = await crypto.subtle.generateKey(
		{ name: 'ECDH', namedCurve: 'P-256' },
		true,
		['deriveBits'],
	);
	const localPublicKey = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeralKeyPair.publicKey));
	const importedUserAgentPublicKey = await crypto.subtle.importKey(
		'raw',
		userAgentPublicKey,
		{ name: 'ECDH', namedCurve: 'P-256' },
		false,
		[],
	);
	const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
		{ name: 'ECDH', public: importedUserAgentPublicKey },
		ephemeralKeyPair.privateKey,
		256,
	));
	const encoder = new TextEncoder();
	const inputKeyMaterial = await hkdfExpand(
		await hkdfExtract(authSecret, sharedSecret),
		concat(encoder.encode('WebPush: info\0'), userAgentPublicKey, localPublicKey),
		32,
	);
	const contentEncryptionKey = await hkdfExpand(
		await hkdfExtract(salt, inputKeyMaterial),
		encoder.encode('Content-Encoding: aes128gcm\0'),
		16,
	);
	const nonce = await hkdfExpand(
		await hkdfExtract(salt, inputKeyMaterial),
		encoder.encode('Content-Encoding: nonce\0'),
		12,
	);
	const plaintext = concat(encoder.encode(payload), new Uint8Array([2]));
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv: nonce },
		await crypto.subtle.importKey('raw', contentEncryptionKey, 'AES-GCM', false, ['encrypt']),
		plaintext,
	));
	if (ciphertext.byteLength > PUSH_RECORD_SIZE - 16) {
		throw new Error('Push payload is too large for a single Web Push record');
	}

	const header = new Uint8Array(21 + localPublicKey.byteLength);
	header.set(salt, 0);
	new DataView(header.buffer).setUint32(16, PUSH_RECORD_SIZE);
	header[20] = localPublicKey.byteLength;
	header.set(localPublicKey, 21);
	return concat(header, ciphertext);
}

async function hkdfExtract(salt: Uint8Array, inputKeyMaterial: Uint8Array): Promise<Uint8Array> {
	return signHmac(salt, inputKeyMaterial);
}

async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
	const output = new Uint8Array(length);
	let previous = new Uint8Array(0);
	for (let offset = 0; offset < length; offset += 32) {
		previous = await signHmac(prk, concat(previous, info, new Uint8Array([offset / 32 + 1])));
		output.set(previous.subarray(0, Math.min(32, length - offset)), offset);
	}
	return output;
}

async function signHmac(keyData: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey(
		'raw',
		keyData,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.byteLength;
	}
	return output;
}
