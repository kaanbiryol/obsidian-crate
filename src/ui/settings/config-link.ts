import { Notice } from 'obsidian';
import type CratePlugin from '../../main';
import { SECRET_KEYS } from '../../plugin/types';
import { SyncApiClient } from '../../sync/api';
import { generateSecureToken, hashToken } from '../../sync/device-token';

export async function buildSetupLink(plugin: CratePlugin): Promise<string | null> {
	const currentAuthToken = plugin.secretStorage.get(SECRET_KEYS.AUTH_TOKEN);
	if (!currentAuthToken) {
		new Notice('Auth token not found');
		return null;
	}

	const enrollmentToken = generateSecureToken();
	const enrollmentTokenHash = await hashToken(enrollmentToken);
	const workerUrl = plugin.settings.workerUrl.replace(/\/$/, '');

	let expiresAt: string;
	try {
		({ expiresAt } = await new SyncApiClient(workerUrl, currentAuthToken)
			.authorizeDeviceEnrollment(enrollmentTokenHash));
	} catch {
		new Notice('Failed to create a setup link for the new device');
		return null;
	}

	const params = new URLSearchParams();
	params.set('workerUrl', workerUrl);
	params.set('enrollmentToken', enrollmentToken);
	params.set('expiresAt', expiresAt);
	return `obsidian://crate-setup?${params.toString()}`;
}
