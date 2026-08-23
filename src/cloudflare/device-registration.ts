import type { CloudflareApiClient } from './cloudflare-api';
import { randomHex } from './pkce';

export interface CloudflareAuthorizedDevice {
	tokenHash: string;
	deviceId: string;
	deviceName: string;
	platform: string;
}

export async function registerCloudflareAuthorizedDevice(input: {
	api: Pick<CloudflareApiClient, 'queryD1'>;
	accountId: string;
	databaseId: string;
	device: CloudflareAuthorizedDevice;
}): Promise<void> {
	await input.api.queryD1(
		input.accountId,
		input.databaseId,
		`DELETE FROM auth_tokens
			WHERE device_id IS NULL AND device_name = 'setup-link' AND last_seen_at IS NULL;`,
	);
	const existing = await input.api.queryD1(
		input.accountId,
		input.databaseId,
		'SELECT id FROM auth_tokens WHERE device_id = ? LIMIT 1;',
		[input.device.deviceId],
	);
	const existingId = existing
		.flatMap(result => result.results ?? [])
		.map(row => row.id)
		.find((id): id is string => typeof id === 'string' && id.length > 0);

	if (existingId) {
		await input.api.queryD1(
			input.accountId,
			input.databaseId,
			`UPDATE auth_tokens
				SET token_hash = ?, device_name = ?, platform = ?, last_seen_at = datetime('now')
				WHERE id = ?;`,
			[input.device.tokenHash, input.device.deviceName, input.device.platform, existingId],
		);
		return;
	}

	await input.api.queryD1(
		input.accountId,
		input.databaseId,
		`INSERT INTO auth_tokens
			(id, token_hash, device_id, device_name, platform, last_seen_at)
			VALUES (?, ?, ?, ?, ?, datetime('now'));`,
		[
			randomHex(16),
			input.device.tokenHash,
			input.device.deviceId,
			input.device.deviceName,
			input.device.platform,
		],
	);
}
