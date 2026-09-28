import { useState } from 'react';
import { DEFAULT_READING_APPEARANCE, type ReadingAppearance } from '@/reading/ui/appearance';

const STORAGE_KEY = 'crate-reading-appearance-v1';

export function loadReadingAppearance(): ReadingAppearance {
	try {
		const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<ReadingAppearance> | null;
		return {
			fontSize: typeof value?.fontSize === 'number' && Number.isInteger(value.fontSize) && value.fontSize >= 16 && value.fontSize <= 26
				? value.fontSize : DEFAULT_READING_APPEARANCE.fontSize,
			serif: typeof value?.serif === 'boolean' ? value.serif : DEFAULT_READING_APPEARANCE.serif,
		};
	} catch {
		return DEFAULT_READING_APPEARANCE;
	}
}

export function saveReadingAppearance(appearance: ReadingAppearance): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance));
	} catch {
		// Keep reading usable when device storage is unavailable, as for the app theme.
	}
}

/** Device preferences outlive individual articles and are saved as soon as changed. */
export function useReadingAppearance() {
	const [appearance, setAppearance] = useState(loadReadingAppearance);
	const updateAppearance = (next: ReadingAppearance) => {
		saveReadingAppearance(next);
		setAppearance(next);
	};
	return { appearance, updateAppearance };
}
