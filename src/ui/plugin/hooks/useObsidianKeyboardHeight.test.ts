import { describe, expect, it } from 'vitest';
import { parseKeyboardHeight } from './useObsidianKeyboardHeight';

describe('parseKeyboardHeight', () => {
	it('reads the pixel value Obsidian publishes', () => {
		expect(parseKeyboardHeight(' 336px')).toBe(336);
		expect(parseKeyboardHeight('291.5px')).toBe(292);
	});

	it('treats a missing or invalid value as no keyboard', () => {
		expect(parseKeyboardHeight('')).toBe(0);
		expect(parseKeyboardHeight('auto')).toBe(0);
		expect(parseKeyboardHeight('-12px')).toBe(0);
	});
});
