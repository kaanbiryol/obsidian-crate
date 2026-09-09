import { expect, it } from 'vitest';
import { decodeMarkdownBytes, MarkdownEncodingError } from './markdownEncoding';

it.each([[0xff], [0xe2, 0x82], [0xff, 0xfe, 65, 0], [65, 0, 66, 0]])('rejects unsupported bytes without substitution: %j', bytes => {
	expect(() => decodeMarkdownBytes(new Uint8Array(bytes))).toThrow(MarkdownEncodingError);
});
it('preserves valid Unicode, a literal replacement character and BOM bytes', () => {
	const bytes = new TextEncoder().encode('\ufeff# 漢字 🙂\nLiteral: �\n');
	expect(new TextEncoder().encode(decodeMarkdownBytes(bytes))).toEqual(bytes);
});
