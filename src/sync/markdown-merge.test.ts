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

	it('merges independent insertions at the same point in stable content order', () => {
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

	it('preserves the common base line ending and final newline style', () => {
		const result = mergeMarkdownContent(
			toArrayBuffer('a\r\nbase local\r\nbase remote\r\n'),
			toArrayBuffer('a\r\nlocal edit\r\nbase remote'),
			toArrayBuffer('a\nbase local\nremote edit\n'),
		);

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.text).toBe('a\r\nlocal edit\r\nremote edit\r\n');
			expect(fromArrayBuffer(result.content)).toBe(result.text);
		}
	});

	it('produces identical bytes when the two devices swap local and remote inputs', () => {
		const base = toArrayBuffer('a\r\nb\r\n');
		const left = toArrayBuffer('a\nleft\nb\n');
		const right = toArrayBuffer('a\r\nright\r\nb');

		const leftFirst = mergeMarkdownContent(base, left, right);
		const rightFirst = mergeMarkdownContent(base, right, left);

		expect(leftFirst.success).toBe(true);
		expect(rightFirst.success).toBe(true);
		if (leftFirst.success && rightFirst.success) {
			expect(fromArrayBuffer(leftFirst.content)).toBe(fromArrayBuffer(rightFirst.content));
			expect(leftFirst.text).toBe('a\r\nleft\r\nright\r\nb\r\n');
		}
	});

	it('orders same-point Unicode insertions by code unit instead of platform collation', () => {
		const result = mergeMarkdownContent(
			toArrayBuffer('a\nb\n'),
			toArrayBuffer('a\né\nb\n'),
			toArrayBuffer('a\nz\nb\n'),
		);

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.text).toBe('a\nz\né\nb\n');
		}
	});
});
