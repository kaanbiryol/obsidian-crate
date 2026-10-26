/** Keys in the OS keychain, shared by plugin, sync and Cloudflare setup. */
export const SECRET_KEYS = {
	AUTH_TOKEN: 'crate-auth-token',
	DEVICE_ID: 'crate-device-id',
	ENCRYPTION_KEYS: 'crate-encryption-keys',
	ENCRYPTION_RESET: 'crate-encryption-reset',
	ENCRYPTION_RECOVERY: 'crate-encryption-recovery',
} as const;

export type SecretKey = (typeof SECRET_KEYS)[keyof typeof SECRET_KEYS] | `crate-usage-oauth-${string}`;
