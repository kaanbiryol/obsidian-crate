/** Brand checking through DataView also recognizes buffers from another realm. */
function view(value: unknown): DataView | undefined {
	if (!value || typeof value !== 'object' || !['[object ArrayBuffer]', '[object SharedArrayBuffer]'].includes(Object.prototype.toString.call(value))) return undefined;
	try { return new DataView(value as ArrayBuffer); }
	catch { return undefined; }
}

/** Vitest's ordinary deep matcher otherwise treats ArrayBuffers as empty objects. */
export function equalBufferBytes(left: unknown, right: unknown): boolean | undefined {
	const a = view(left);
	const b = view(right);
	if (!a && !b) return undefined;
	if (!a || !b || a.byteLength !== b.byteLength) return false;
	for (let index = 0; index < a.byteLength; index++) {
		if (a.getUint8(index) !== b.getUint8(index)) return false;
	}
	return true;
}
