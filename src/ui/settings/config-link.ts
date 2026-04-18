import { Notice, requestUrl } from 'obsidian';
import { generateAuthToken } from '../../cloudflare/api';
import { computeTokenHash } from '../../cloudflare/infrastructure';
import type CratePlugin from '../../main';
import { SECRET_KEYS } from '../../plugin/types';

export async function buildSetupLink(plugin: CratePlugin): Promise<string | null> {
	const currentAuthToken = plugin.secretStorage.get(SECRET_KEYS.AUTH_TOKEN);
	if (!currentAuthToken) {
		new Notice('Auth token not found');
		return null;
	}

	const newToken = generateAuthToken();
	const tokenHash = await computeTokenHash(newToken);
	const workerUrl = plugin.settings.workerUrl.replace(/\/$/, '');

	try {
		await requestUrl({
			url: `${workerUrl}/auth/tokens`,
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${currentAuthToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ token_hash: tokenHash, device_name: 'setup-link' }),
		});
	} catch {
		new Notice('Failed to register token for new device');
		return null;
	}

	const params = new URLSearchParams();
	params.set('workerUrl', plugin.settings.workerUrl);
	params.set('authToken', newToken);
	if (plugin.settings.workerName) {
		params.set('workerName', plugin.settings.workerName);
	}
	if (plugin.settings.bucketName) {
		params.set('bucketName', plugin.settings.bucketName);
	}
	if (plugin.settings.databaseId) {
		params.set('databaseId', plugin.settings.databaseId);
	}
	if (plugin.settings.cloudflareAccountId) {
		params.set('accountId', plugin.settings.cloudflareAccountId);
	}
	return `obsidian://crate-setup?${params.toString()}`;
}
