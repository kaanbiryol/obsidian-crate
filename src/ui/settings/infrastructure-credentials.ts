import { Notice } from 'obsidian';
import type CratePlugin from '../../main';
import { getErrorMessage } from './action-helpers';
import type { ResolveCredentialResult } from './infrastructure-types';

export async function resolveCloudflareCredentials(plugin: CratePlugin): Promise<ResolveCredentialResult> {
	try {
		const credentials = await plugin.cloudflareSession.resolveCredentials();
		return { credentials, hadError: false };
	} catch (error) {
		new Notice(`Cloudflare session refresh failed: ${getErrorMessage(error)}`);
		return { credentials: null, hadError: true };
	}
}
