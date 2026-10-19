import { MAX_PUSH_PAYLOAD_BYTES, PushPayloadError } from './payload-budget';
import { isValidPushEndpoint } from './push-endpoint';
import { toBase64Url } from 'web-push-browser';
// Import only encryption: the package root also bundles Node HTTP/proxy transports.
import { encrypt } from 'web-push/src/encryption-helper.js';

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

async function createVapidAuthorization(vapidKeys: CryptoKeyPair, endpoint: URL): Promise<string> {
	const [jwt, exportedPublicKey] = await Promise.all([
		createVapidAuthorizationToken(vapidKeys.privateKey, endpoint),
		crypto.subtle.exportKey('raw', vapidKeys.publicKey),
	]);
	return `vapid t=${jwt}, k=${toBase64Url(exportedPublicKey)}`;
}

export async function sendPushNotificationWithoutContact(
	vapidKeys: CryptoKeyPair,
	subscription: WebPushSubscription,
	payload: string,
	authorizations?: Map<string, Promise<string>>,
): Promise<Response> {
	if (new TextEncoder().encode(payload).byteLength > MAX_PUSH_PAYLOAD_BYTES) throw new PushPayloadError('Push payload exceeds the Web Push byte limit');
	if (!isValidPushEndpoint(subscription.endpoint)) throw new Error('Push service is not supported');
	const encryptedPayload = encrypt(subscription.keys.p256dh, subscription.keys.auth, payload, 'aes128gcm').cipherText;
	const endpoint = new URL(subscription.endpoint);
	// One send reuses its VAPID token for every endpoint on the same push service.
	let authorization = authorizations?.get(endpoint.origin);
	if (!authorization) {
		authorization = createVapidAuthorization(vapidKeys, endpoint);
		authorizations?.set(endpoint.origin, authorization);
	}
	const headers = new Headers({
		'Content-Type': 'application/octet-stream',
		'Content-Length': String(encryptedPayload.byteLength),
		TTL: '86400',
		Authorization: await authorization,
		'Content-Encoding': 'aes128gcm',
	});

	return fetch(new Request(subscription.endpoint, {
		method: 'POST',
		// Workers only support follow/manual. Return redirects to the caller's
		// failure handling without forwarding the payload or VAPID credentials.
		redirect: 'manual',
		signal: AbortSignal.timeout(10_000),
		headers,
		body: new Uint8Array(encryptedPayload),
	}));
}
