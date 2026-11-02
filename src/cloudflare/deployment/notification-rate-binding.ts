export const NOTIFICATION_RATE_BINDING = 'NOTIFICATION_REQUEST_LIMITER';
export function notificationRateNamespace(bucketName: string): string {
	// Vault resource names contain a stable random hexadecimal suffix. Keep the
	// namespace within the exact integer range supported by JS and the API.
	const suffix = bucketName.match(/([a-f0-9]{8})$/)?.[1];
	if (!suffix) throw new Error('Invalid Crate bucket name for notification rate limit');
	return String(Number.parseInt(suffix, 16) + 1);
}
