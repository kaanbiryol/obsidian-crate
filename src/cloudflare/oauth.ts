/**
 * Cloudflare OAuth helpers for in-plugin login.
 * Desktop-first flow using localhost callback, mirroring CLI behavior.
 */

import { Platform, requestUrl } from 'obsidian';
import { createServer } from 'http';

const CLIENT_ID = '54d11594-84e4-41aa-b438-e81b8fa78ee7';
const AUTH_URL = 'https://dash.cloudflare.com/oauth2/auth';
const TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token';
const REDIRECT_PORT = 8976;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth/callback`;
const SCOPES = [
	'account:read',
	'user:read',
	'workers:write',
	'workers_scripts:write',
	'd1:write',
	'offline_access',
];

export interface OAuthTokens {
	accessToken: string;
	refreshToken?: string;
	expiresAt?: number;
}

export interface OAuthResult {
	accountId: string;
	tokens: OAuthTokens;
}

function createRandomHex(bytes: number): string {
	const array = new Uint8Array(bytes);
	crypto.getRandomValues(array);
	return Array.from(array, (value) => value.toString(16).padStart(2, '0')).join('');
}

function createCodeVerifier(): string {
	const array = new Uint8Array(32);
	crypto.getRandomValues(array);
	let binary = '';
	for (const byte of array) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function createCodeChallenge(verifier: string): Promise<string> {
	const encoder = new TextEncoder();
	const digest = await crypto.subtle.digest('SHA-256', encoder.encode(verifier));
	const bytes = new Uint8Array(digest);
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function getAuthorizationUrl(state: string, codeChallenge: string): string {
	const params = new URLSearchParams({
		response_type: 'code',
		client_id: CLIENT_ID,
		redirect_uri: REDIRECT_URI,
		scope: SCOPES.join(' '),
		state,
		code_challenge: codeChallenge,
		code_challenge_method: 'S256',
	});

	return `${AUTH_URL}?${params.toString()}`;
}

async function fetchAccountId(accessToken: string): Promise<string> {
	const response = await requestUrl({
		url: 'https://api.cloudflare.com/client/v4/accounts',
		method: 'GET',
		headers: {
			Authorization: `Bearer ${accessToken}`,
		},
		throw: false,
	});

	if (response.status >= 400) {
		throw new Error(`Failed to fetch account ID (status ${response.status})`);
	}

	const data = response.json as {
		success?: boolean;
		result?: Array<{ id: string; name?: string }>;
	};

	if (!data.success || !data.result || data.result.length === 0) {
		throw new Error('No Cloudflare accounts found for this user');
	}

	return data.result[0]!.id;
}

export async function refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
	const response = await requestUrl({
		url: TOKEN_URL,
		method: 'POST',
		contentType: 'application/x-www-form-urlencoded',
		body: new URLSearchParams({
			grant_type: 'refresh_token',
			client_id: CLIENT_ID,
			refresh_token: refreshToken,
		}).toString(),
		throw: false,
	});

	if (response.status >= 400) {
		throw new Error(`Token refresh failed (status ${response.status})`);
	}

	const data = response.json as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
	};

	if (!data.access_token) {
		throw new Error('Token refresh response did not include access token');
	}

	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
	};
}

async function exchangeCodeForToken(code: string, codeVerifier: string): Promise<OAuthTokens> {
	const response = await requestUrl({
		url: TOKEN_URL,
		method: 'POST',
		contentType: 'application/x-www-form-urlencoded',
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			client_id: CLIENT_ID,
			code,
			redirect_uri: REDIRECT_URI,
			code_verifier: codeVerifier,
		}).toString(),
		throw: false,
	});

	if (response.status >= 400) {
		throw new Error(`Token exchange failed (status ${response.status})`);
	}

	const data = response.json as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
	};

	if (!data.access_token) {
		throw new Error('Token exchange response did not include access token');
	}

	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
	};
}

let activeServer: ReturnType<typeof createServer> | null = null;
let activeTimeout: ReturnType<typeof setTimeout> | null = null;

export function abortOAuthLogin(): void {
	if (activeTimeout) {
		clearTimeout(activeTimeout);
		activeTimeout = null;
	}
	if (activeServer) {
		activeServer.close();
		activeServer = null;
	}
}

export async function performOAuthLogin(openBrowser: (url: string) => Promise<void>): Promise<OAuthResult> {
	if (!Platform.isDesktopApp) {
		throw new Error('Cloudflare sign-in is currently supported on desktop only');
	}

	abortOAuthLogin();

	const state = createRandomHex(16);
	const codeVerifier = createCodeVerifier();
	const codeChallenge = await createCodeChallenge(codeVerifier);
	const authUrl = getAuthorizationUrl(state, codeChallenge);

	return new Promise((resolve, reject) => {
		const cleanup = () => {
			activeServer = null;
			activeTimeout = null;
		};

		const timeoutHandle = setTimeout(() => {
			server.close();
			cleanup();
			reject(new Error('OAuth login timed out after 5 minutes'));
		}, 5 * 60 * 1000);

		const server = createServer(async (req, res) => {
			try {
				const url = new URL(req.url || '/', `http://localhost:${REDIRECT_PORT}`);
				if (url.pathname !== '/oauth/callback') {
					res.writeHead(404);
					res.end('Not found');
					return;
				}

				const returnedState = url.searchParams.get('state');
				const code = url.searchParams.get('code');
				const oauthError = url.searchParams.get('error');

				if (oauthError) {
					res.writeHead(400, { 'Content-Type': 'text/html' });
					res.end('<html><body><h2>Cloudflare authorization failed.</h2><p>You can close this tab.</p></body></html>');
					clearTimeout(timeoutHandle);
					server.close();
					cleanup();
					reject(new Error(`OAuth error: ${oauthError}`));
					return;
				}

				if (returnedState !== state) {
					res.writeHead(400, { 'Content-Type': 'text/html' });
					res.end('<html><body><h2>State mismatch.</h2><p>You can close this tab.</p></body></html>');
					clearTimeout(timeoutHandle);
					server.close();
					cleanup();
					reject(new Error('OAuth state mismatch'));
					return;
				}

				if (!code) {
					res.writeHead(400, { 'Content-Type': 'text/html' });
					res.end('<html><body><h2>No authorization code.</h2><p>You can close this tab.</p></body></html>');
					clearTimeout(timeoutHandle);
					server.close();
					cleanup();
					reject(new Error('No authorization code returned by Cloudflare'));
					return;
				}

				const tokens = await exchangeCodeForToken(code, codeVerifier);
				const accountId = await fetchAccountId(tokens.accessToken);

				res.writeHead(200, { 'Content-Type': 'text/html' });
				res.end('<html><body><h2>Authorization successful.</h2><p>You can return to Obsidian.</p></body></html>');

				clearTimeout(timeoutHandle);
				server.close();
				cleanup();
				resolve({ accountId, tokens });
			} catch (error) {
				res.writeHead(500, { 'Content-Type': 'text/html' });
				res.end('<html><body><h2>Authorization failed.</h2><p>You can close this tab.</p></body></html>');
				clearTimeout(timeoutHandle);
				server.close();
				cleanup();
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});

		server.on('error', (error) => {
			clearTimeout(timeoutHandle);
			cleanup();
			reject(new Error(`Failed to start OAuth callback server: ${error.message}`));
		});

		activeServer = server;
		activeTimeout = timeoutHandle;

		server.listen(REDIRECT_PORT, '127.0.0.1', async () => {
			try {
				await openBrowser(authUrl);
			} catch {
				// If opening fails, the user can still copy URL from notice/UI.
			}
		});
	});
}
