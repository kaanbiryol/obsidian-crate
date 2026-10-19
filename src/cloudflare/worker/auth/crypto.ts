import { sha256Hex as sha256 } from '../../../platform/sha256';

export function createRandomHexToken(byteLength = 32): string {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(text: string): Promise<string> {
	return sha256(text);
}

export async function sha256HexBytes(data: BufferSource): Promise<string> {
	return sha256(data);
}
