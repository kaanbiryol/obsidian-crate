/**
 * OAuth authentication for Cloudflare
 * Uses PKCE flow with Wrangler's public client ID
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { randomBytes, createHash } from 'crypto';
import { URL } from 'url';

const CLIENT_ID = '54d11594-84e4-41aa-b438-e81b8fa78ee7';
const AUTH_URL = 'https://dash.cloudflare.com/oauth2/auth';
const TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token';
const REDIRECT_PORT = 8976;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth/callback`;
const SCOPES = ['account:read', 'user:read', 'workers:write', 'workers_kv:write', 'workers_routes:write', 'workers_scripts:write', 'workers_tail:read', 'd1:write', 'pages:write', 'zone:read', 'offline_access'];

export interface OAuthTokens {
	accessToken: string;
	refreshToken?: string;
	expiresAt?: number;
}

export interface OAuthResult {
	tokens: OAuthTokens;
	accountId: string;
}

function generateCodeVerifier(): string {
	return randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
	return createHash('sha256').update(verifier).digest('base64url');
}

function generateState(): string {
	return randomBytes(16).toString('hex');
}

export function getAuthorizationUrl(state: string, codeChallenge: string): string {
	const params = new URLSearchParams({
		response_type: 'code',
		client_id: CLIENT_ID,
		redirect_uri: REDIRECT_URI,
		scope: SCOPES.join(' '),
		state: state,
		code_challenge: codeChallenge,
		code_challenge_method: 'S256',
	});

	return `${AUTH_URL}?${params.toString()}`;
}

async function exchangeCodeForToken(code: string, codeVerifier: string): Promise<OAuthTokens> {
	const response = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			client_id: CLIENT_ID,
			code: code,
			redirect_uri: REDIRECT_URI,
			code_verifier: codeVerifier,
		}),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Token exchange failed: ${text}`);
	}

	const data = await response.json() as {
		access_token: string;
		refresh_token?: string;
		expires_in?: number;
	};

	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
	};
}

async function fetchAccountId(accessToken: string): Promise<string> {
	const response = await fetch('https://api.cloudflare.com/client/v4/accounts', {
		headers: {
			'Authorization': `Bearer ${accessToken}`,
		},
	});

	if (!response.ok) {
		throw new Error('Failed to fetch account ID');
	}

	const data = await response.json() as {
		success: boolean;
		result: Array<{ id: string; name: string }>;
	};

	if (!data.success || !data.result || data.result.length === 0) {
		throw new Error('No Cloudflare accounts found');
	}

	// If there's only one account, use it
	if (data.result.length === 1) {
		return data.result[0].id;
	}

	// If there are multiple accounts, return the first one
	// In a more sophisticated implementation, we could let the user choose
	console.log(`Found ${data.result.length} accounts, using: ${data.result[0].name}`);
	return data.result[0].id;
}

export async function refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
	const response = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: new URLSearchParams({
			grant_type: 'refresh_token',
			client_id: CLIENT_ID,
			refresh_token: refreshToken,
		}),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Token refresh failed: ${text}`);
	}

	const data = await response.json() as {
		access_token: string;
		refresh_token?: string;
		expires_in?: number;
	};

	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
	};
}

export async function performOAuthFlow(openBrowser: (url: string) => Promise<void>): Promise<OAuthResult> {
	const state = generateState();
	const codeVerifier = generateCodeVerifier();
	const codeChallenge = generateCodeChallenge(codeVerifier);

	return new Promise((resolve, reject) => {
		const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
			const url = new URL(req.url || '/', `http://localhost:${REDIRECT_PORT}`);

			if (url.pathname === '/oauth/callback') {
				const code = url.searchParams.get('code');
				const returnedState = url.searchParams.get('state');
				const error = url.searchParams.get('error');

				if (error) {
					res.writeHead(400, { 'Content-Type': 'text/html' });
					res.end(`
						<html>
							<body style="font-family: system-ui; text-align: center; padding: 50px;">
								<h1>Authorization Failed</h1>
								<p>Error: ${error}</p>
								<p>You can close this window.</p>
							</body>
						</html>
					`);
					server.close();
					reject(new Error(`OAuth error: ${error}`));
					return;
				}

				if (returnedState !== state) {
					res.writeHead(400, { 'Content-Type': 'text/html' });
					res.end(`
						<html>
							<body style="font-family: system-ui; text-align: center; padding: 50px;">
								<h1>Authorization Failed</h1>
								<p>State mismatch - possible CSRF attack.</p>
								<p>You can close this window.</p>
							</body>
						</html>
					`);
					server.close();
					reject(new Error('State mismatch'));
					return;
				}

				if (!code) {
					res.writeHead(400, { 'Content-Type': 'text/html' });
					res.end(`
						<html>
							<body style="font-family: system-ui; text-align: center; padding: 50px;">
								<h1>Authorization Failed</h1>
								<p>No authorization code received.</p>
								<p>You can close this window.</p>
							</body>
						</html>
					`);
					server.close();
					reject(new Error('No authorization code'));
					return;
				}

				try {
					const tokens = await exchangeCodeForToken(code, codeVerifier);
					const accountId = await fetchAccountId(tokens.accessToken);

					res.writeHead(200, { 'Content-Type': 'text/html' });
					res.end(`
						<html>
							<body style="font-family: system-ui; text-align: center; padding: 50px;">
								<h1>Authorization Successful!</h1>
								<p>You can close this window and return to the terminal.</p>
							</body>
						</html>
					`);

					server.close();
					resolve({ tokens, accountId });
				} catch (err) {
					res.writeHead(500, { 'Content-Type': 'text/html' });
					res.end(`
						<html>
							<body style="font-family: system-ui; text-align: center; padding: 50px;">
								<h1>Authorization Failed</h1>
								<p>${err instanceof Error ? err.message : 'Unknown error'}</p>
								<p>You can close this window.</p>
							</body>
						</html>
					`);
					server.close();
					reject(err);
				}
			} else {
				res.writeHead(404);
				res.end('Not found');
			}
		});

		server.on('error', (err) => {
			reject(new Error(`Failed to start local server: ${err.message}`));
		});

		server.listen(REDIRECT_PORT, async () => {
			const authUrl = getAuthorizationUrl(state, codeChallenge);
			console.log('\nOpening browser for Cloudflare authorization...');
			console.log(`If the browser doesn't open, visit: ${authUrl}\n`);

			try {
				await openBrowser(authUrl);
			} catch {
				console.log('Could not open browser automatically.');
			}
		});

		// Timeout after 5 minutes
		setTimeout(() => {
			server.close();
			reject(new Error('OAuth flow timed out after 5 minutes'));
		}, 5 * 60 * 1000);
	});
}
