// A 1 MiB reminder note can expand sixfold when JSON escapes control characters.
// Legacy responses already fit a D1 row, but conversion stores two encrypted copies.
export const MAX_ENCRYPTED_REMINDER_ACK = Math.ceil((6 * 1024 * 1024 + 16 * 1024) * 4 / 3) + 4096;
export const MAX_CONVERTED_RECEIPT_BYTES = 6 * 1024 * 1024;
export const MAX_ENCRYPTED_REMINDER_REQUEST_BYTES = 24 * 1024 * 1024;

export function isReceiptEnvelope(value: unknown): value is string {
	return typeof value === 'string' && value.length <= MAX_ENCRYPTED_REMINDER_ACK
		&& value.split('.').length === 5 && /^[A-Za-z0-9_.-]+$/.test(value);
}
