import { describe, expect, it } from 'vitest';
import { mergeMarkdownContent } from './markdown-merge';

function toArrayBuffer(text: string): ArrayBuffer {
	return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function fromArrayBuffer(buffer: ArrayBuffer): string {
	return new TextDecoder().decode(new Uint8Array(buffer));
}

describe('mergeMarkdownContent', () => {
	it('merges non-overlapping line edits', () => {
		const result = mergeMarkdownContent(
			toArrayBuffer('title\nbase local\nbase remote\n'),
			toArrayBuffer('title\nlocal edit\nbase remote\n'),
			toArrayBuffer('title\nbase local\nremote edit\n'),
		);

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.text).toBe('title\nlocal edit\nremote edit\n');
		}
	});

	it('merges independent insertions at the same point in stable local-then-remote order', () => {
		const result = mergeMarkdownContent(
			toArrayBuffer('a\nb\n'),
			toArrayBuffer('a\nlocal\nb\n'),
			toArrayBuffer('a\nremote\nb\n'),
		);

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.text).toBe('a\nlocal\nremote\nb\n');
		}
	});

	it('applies identical edits once', () => {
		const result = mergeMarkdownContent(
			toArrayBuffer('a\nold\nb\n'),
			toArrayBuffer('a\nnew\nb\n'),
			toArrayBuffer('a\nnew\nb\n'),
		);

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.text).toBe('a\nnew\nb\n');
		}
	});

	it('rejects overlapping different edits', () => {
		const result = mergeMarkdownContent(
			toArrayBuffer('a\nold\nb\n'),
			toArrayBuffer('a\nlocal\nb\n'),
			toArrayBuffer('a\nremote\nb\n'),
		);

		expect(result).toEqual({ success: false, reason: 'overlap' });
	});

	it('preserves the local file line ending and final newline style', () => {
		const result = mergeMarkdownContent(
			toArrayBuffer('a\r\nbase local\r\nbase remote\r\n'),
			toArrayBuffer('a\r\nlocal edit\r\nbase remote'),
			toArrayBuffer('a\nbase local\nremote edit\n'),
		);

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.text).toBe('a\r\nlocal edit\r\nremote edit');
			expect(fromArrayBuffer(result.content)).toBe(result.text);
		}
	});
});
