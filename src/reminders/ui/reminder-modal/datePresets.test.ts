import { describe, expect, it } from 'vitest';
import { getReminderDateForPreset, REMINDER_DATE_PRESETS } from './datePresets';

describe('shared reminder date presets', () => {
	it('keeps the plugin and PWA preset labels in one ordered contract', () => {
		expect(REMINDER_DATE_PRESETS.map(({ label }) => label)).toEqual([
			'Today',
			'Tomorrow',
			'This evening',
			'Next week',
		]);
	});

	it('sets this evening to 18:00 and rolls forward after 18:00', () => {
		const beforeEvening = getReminderDateForPreset('evening', new Date(2026, 8, 1, 12));
		const afterEvening = getReminderDateForPreset('evening', new Date(2026, 8, 1, 20));

		expect(beforeEvening).toEqual(new Date(2026, 8, 1, 18));
		expect(afterEvening).toEqual(new Date(2026, 8, 2, 18));
	});

	it('defines next week as seven days from today', () => {
		expect(getReminderDateForPreset('next-week', new Date(2026, 8, 1, 12)))
			.toEqual(new Date(2026, 8, 8));
	});
});
