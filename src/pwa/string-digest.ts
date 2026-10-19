import { sha256Hex } from '@/platform/sha256';

/** Stable UTF-8 SHA-256 encoding shared by enrollment and request identities. */
export async function stringDigest(value: string): Promise<string> {
	return sha256Hex(value);
}
