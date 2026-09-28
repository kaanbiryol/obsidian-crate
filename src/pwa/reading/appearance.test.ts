import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadReadingAppearance, saveReadingAppearance } from './appearance';

afterEach(() => vi.unstubAllGlobals());

function storage(raw: string | null = null) {
	const values = new Map(raw === null ? [] : [['crate-reading-appearance-v1', raw]]);
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
	});
}

describe('Reading appearance on this device', () => {
	it('restores both preferences after saving', () => {
		storage();
		expect(loadReadingAppearance()).toEqual({ fontSize: 19, serif: false });
		saveReadingAppearance({ fontSize: 23, serif: true });
		expect(loadReadingAppearance()).toEqual({ fontSize: 23, serif: true });
	});

	it.each(['{', 'null', '[]', '42', '{"fontSize":27,"serif":"true"}', '{"fontSize":15}', '{"fontSize":19.5}', '{"fontSize":"22"}'])('ignores invalid stored preferences: %s', raw => {
		storage(raw);
		expect(loadReadingAppearance()).toEqual({ fontSize: 19, serif: false });
	});

	it('retains a valid preference when the other is invalid', () => {
		storage('{"fontSize":100,"serif":true}');
		expect(loadReadingAppearance()).toEqual({ fontSize: 19, serif: true });
	});

	it('keeps reading usable when storage access is denied', () => {
		vi.stubGlobal('localStorage', {
			getItem: () => { throw new Error('Denied'); },
			setItem: () => { throw new Error('Quota exceeded'); },
		});
		expect(loadReadingAppearance()).toEqual({ fontSize: 19, serif: false });
		expect(() => saveReadingAppearance({ fontSize: 26, serif: true })).not.toThrow();
	});
});
