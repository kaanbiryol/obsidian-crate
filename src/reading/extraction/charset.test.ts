import { expect, it } from 'vitest';
import { decodeHtml } from './charset';

// "café “quoted”" in windows-1252.
const legacy = (head: string) => new Uint8Array([...new TextEncoder().encode(`<html><head>${head}</head><body>caf`), 0xe9, 0x20, 0x93, 0x71, 0x94, ...new TextEncoder().encode('</body></html>')]);

it.each([
	'<meta charset="windows-1252">',
	'<meta http-equiv="Content-Type" content="text/html; charset=windows-1252">',
])('decodes a legacy encoding declared only in markup: %s', head => {
	expect(decodeHtml(legacy(head), 'text/html')).toContain('café “q”');
	expect(decodeHtml(legacy(head).buffer, null)).toContain('café “q”');
});

it('prefers the Content-Type charset over markup', () => {
	const bytes = new TextEncoder().encode('<meta charset="windows-1252"><p>café</p>');
	expect(decodeHtml(bytes, 'text/html; charset=utf-8')).toContain('café');
});

it.each(['text/html; charset=bogus', 'text/html', null])('decodes an unknown or missing label as UTF-8: %s', contentType => {
	const bytes = new TextEncoder().encode('<meta charset="also-bogus"><p>café</p>');
	expect(decodeHtml(bytes, contentType)).toContain('café');
});

it('reads a UTF-16 declaration in ASCII-compatible markup as UTF-8', () => {
	expect(decodeHtml(new TextEncoder().encode('<meta charset="utf-16"><p>café</p>'), 'text/html')).toContain('café');
});

const page = '<meta charset="windows-1252"><p>café</p>';
const utf16 = (text: string, littleEndian: boolean) => {
	const bytes = new Uint8Array(2 + text.length * 2), view = new DataView(bytes.buffer);
	view.setUint16(0, 0xfeff, littleEndian);
	for (let index = 0; index < text.length; index++) view.setUint16(2 + index * 2, text.charCodeAt(index), littleEndian);
	return bytes;
};

it.each([
	['UTF-8', new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(page)])],
	['UTF-16LE', utf16(page, true)],
	['UTF-16BE', utf16(page, false)],
])('decodes with a %s byte order mark over header and markup charsets', (_, bytes) => {
	expect(decodeHtml(bytes, 'text/html; charset=windows-1252')).toBe(page);
	expect(decodeHtml(bytes.buffer, 'text/html')).toBe(page);
});
