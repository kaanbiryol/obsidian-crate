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

	const subtle = crypto.subtle as SubtleCrypto & {
		timingSafeEqual?: (left: BufferSource, right: BufferSource) => boolean | Promise<boolean>;
	};
	if (typeof subtle.timingSafeEqual === 'function') {
		if (aBytes.byteLength !== bBytes.byteLength) {
			await subtle.timingSafeEqual(aBytes, aBytes);
			return false;
		}
		return await subtle.timingSafeEqual(aBytes, bBytes);
	}

	const maxLength = Math.max(aBytes.byteLength, bBytes.byteLength, 1);
	let diff = aBytes.byteLength ^ bBytes.byteLength;
	for (let index = 0; index < maxLength; index++) {
		const aValue = index < aBytes.byteLength ? aBytes[index] : 0;
		const bValue = index < bBytes.byteLength ? bBytes[index] : 0;
		diff |= aValue ^ bValue;
	}
	return diff === 0;
}
