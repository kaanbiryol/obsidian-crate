const META_CHARSET = /<meta\b[^>]*?charset\s*=\s*["']?\s*([\w-]+)/i;

function decoderFor(label: string | undefined): TextDecoder | undefined {
	if (!label) return undefined;
	try { return new TextDecoder(label); } catch { return undefined; }
}

/** A `<meta>` declaration within the first 1024 bytes, as browsers prescan. A
 * UTF-16 declaration in ASCII-compatible bytes means UTF-8. */
function metaCharset(bytes: ArrayBuffer | Uint8Array): string | undefined {
	const head = (bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).subarray(0, 1024);
	const label = META_CHARSET.exec(new TextDecoder('windows-1252').decode(head))?.[1];
	return label && /^utf-16/i.test(label) ? 'utf-8' : label;
}

/** Decodes a fetched page with its Content-Type charset, else its `<meta>`
 * charset, else UTF-8. An unknown label is skipped instead of failing the capture. */
export function decodeHtml(bytes: ArrayBuffer | Uint8Array, contentType: string | null): string {
	const declared = /charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1];
	return (decoderFor(declared) ?? decoderFor(metaCharset(bytes)) ?? new TextDecoder()).decode(bytes);
}
