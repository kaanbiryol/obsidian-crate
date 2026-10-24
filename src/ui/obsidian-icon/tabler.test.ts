import { describe, expect, it, vi } from 'vitest';

const addIcon = vi.fn();
vi.mock('obsidian', () => ({ addIcon }));

const { obsidianIconId } = await import('./tabler');

describe('obsidianIconId', () => {
	it('registers bundled Tabler icons once under a Crate prefix', () => {
		expect(obsidianIconId('trash-2')).toBe('crate-tabler-trash-2');
		expect(obsidianIconId('copy')).toBe('crate-tabler-copy');
		const registrations = addIcon.mock.calls.length;
		expect(registrations).toBeGreaterThan(50);
		expect(addIcon.mock.calls.every(([id]) => String(id).startsWith('crate-tabler-'))).toBe(true);
		expect(addIcon).toHaveBeenCalledWith('crate-tabler-trash-2', expect.stringContaining('scale(4.1666667)'));
		expect(addIcon.mock.calls.length).toBe(registrations);
	});

	it('falls back to Obsidian icons for ids without a Tabler drawing', () => {
		expect(obsidianIconId('not-a-crate-icon')).toBe('not-a-crate-icon');
	});
});
