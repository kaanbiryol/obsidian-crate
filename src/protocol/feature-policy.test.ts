import { expect, it } from 'vitest';
import { parseFeaturePolicy, parseSharedFeatures } from './feature-policy';

it('reads feature switches without carrying extra fields', () => {
	expect(parseSharedFeatures({ reading: false, reminders: true, revision: 'one', extra: 1 })).toEqual({ reading: false, reminders: true });
	expect(parseSharedFeatures({ reading: 'false', reminders: true })).toBeNull();
	expect(parseSharedFeatures(null)).toBeNull();
});

it('requires a string or null policy revision', () => {
	expect(parseFeaturePolicy({ reading: true, reminders: false, revision: null })).toEqual({ reading: true, reminders: false, revision: null });
	expect(parseFeaturePolicy({ reading: true, reminders: false, revision: 'one' })).toEqual({ reading: true, reminders: false, revision: 'one' });
	expect(parseFeaturePolicy({ reading: true, reminders: false })).toBeNull();
	expect(parseFeaturePolicy({ reading: true, reminders: false, revision: 1 })).toBeNull();
});
