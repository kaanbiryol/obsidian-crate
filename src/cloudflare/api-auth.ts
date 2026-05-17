import { requestUrl } from 'obsidian';
import type { CloudflareAccount, CloudflareCredentials, CloudflareEnvelope } from './api-types';
import { CF_API_BASE, formatCloudflareError } from './api-transport';

const CRATE_TOKEN_TEMPLATE_PERMISSIONS = [
	{ key: 'workers_scripts', type: 'edit' },
	{ key: 'workers_r2', type: 'edit' },
	{ key: 'd1', type: 'edit' },
	{ key: 'account_settings', type: 'read' },
	{ key: 'account_analytics', type: 'read' },
] as const;

export async function verifyCredentials(credentials: CloudflareCredentials): Promise<boolean> {
	return verifyToken(credentials.apiToken);
}

export async function verifyToken(apiToken: string): Promise<boolean> {
	try {
		const response = await requestUrl({
			url: `${CF_API_BASE}/user/tokens/verify`,
			method: 'GET',
			headers: { Authorization: `Bearer ${apiToken}` },
			throw: false,
		});
		if (response.status >= 400) return false;
		const json = response.json as CloudflareEnvelope<{ status?: string }>;
		return json.success === true;
	} catch {
		return false;
	}
}

export async function listAccessibleAccounts(apiToken: string): Promise<CloudflareAccount[]> {
	const response = await requestUrl({
		url: `${CF_API_BASE}/accounts`,
		method: 'GET',
		headers: { Authorization: `Bearer ${apiToken}` },
		throw: false,
	});

	if (response.status >= 400) {
		throw formatCloudflareError(response.status, response.json);
	}

	const json = response.json as CloudflareEnvelope<Array<{ id: string; name: string }>>;
	if (!json.success || !Array.isArray(json.result)) {
		throw new Error('Failed to fetch Cloudflare accounts');
	}

	return json.result.map(a => ({ id: a.id, name: a.name }));
}

export function buildCloudflareTokenTemplateUrl(): string {
	const params = new URLSearchParams({
		permissionGroupKeys: JSON.stringify(CRATE_TOKEN_TEMPLATE_PERMISSIONS),
		accountId: '*',
		zoneId: 'all',
		name: 'Crate',
	});
	return `https://dash.cloudflare.com/profile/api-tokens?${params.toString()}`;
}
