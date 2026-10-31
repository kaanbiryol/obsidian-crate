import type { CloudflareApiClient } from '../cloudflare-api';
import type { CloudflareDeploymentMetadata } from './types';
import { createRandomHexToken } from '../../platform/random-hex';
import { sha256Hex } from '../../platform/sha256';
import { DEVICE_PAIRING_END, DEVICE_PAIRING_LIFETIME, DEVICE_PAIRING_PREFIX } from '../../protocol/device-pairing';

export interface IssuedDevicePairing { code: string; tokenId: string; expiresAt: number }

/** Records a one-use code through the Cloudflare D1 API and replaces any earlier
 * unredeemed one. The Worker stores only the code's hash. The record carries this
 * server's identity, without its deletion progress, so the new device can manage it. */
export async function issueDevicePairingCode(input: {
	api: Pick<CloudflareApiClient, 'queryD1'>;
	accountId: string;
	databaseId: string;
	metadata: CloudflareDeploymentMetadata;
	now: number;
}): Promise<IssuedDevicePairing> {
	const code = createRandomHexToken(), tokenId = createRandomHexToken(16), expiresAt = input.now + DEVICE_PAIRING_LIFETIME;
	const { deletion: _deletion, ...deployment } = input.metadata;
	await input.api.queryD1(input.accountId, input.databaseId,
		'DELETE FROM maintenance_state WHERE key >= ? AND key < ?;', [DEVICE_PAIRING_PREFIX, DEVICE_PAIRING_END]);
	await input.api.queryD1(input.accountId, input.databaseId,
		`INSERT INTO maintenance_state (key, value)
			SELECT ?, json_set(?, '$.resetGeneration', COALESCE((SELECT reset_generation FROM server_state WHERE id = 1), ''));`,
		[DEVICE_PAIRING_PREFIX + await sha256Hex(code), JSON.stringify({ id: tokenId, expiresAt, resetGeneration: '', deployment })]);
	return { code, tokenId, expiresAt };
}
