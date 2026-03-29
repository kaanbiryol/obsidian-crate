async function digestHex(data: BufferSource): Promise<string> {
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = new Uint8Array(hashBuffer);
	return Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(text: string): Promise<string> {
	return digestHex(new TextEncoder().encode(text));
}

export async function sha256HexBytes(data: BufferSource): Promise<string> {
	return digestHex(data);
}

export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const aBytes = encoder.encode(a);
	const bBytes = encoder.encode(b);
	if (aBytes.byteLength !== bBytes.byteLength) {
		await crypto.subtle.timingSafeEqual(aBytes, aBytes);
		return false;
	}
	return crypto.subtle.timingSafeEqual(aBytes, bBytes);
}
