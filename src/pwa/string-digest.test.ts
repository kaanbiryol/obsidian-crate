import { expect, it } from 'vitest';
import { stringDigest } from './string-digest';
import { enrollmentFingerprint } from './install-enrollment';

it.each([
		['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
		['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
		['Keep exact details 🗒️', '9a653e1e526b3983982a95e8b3333859ed3130c1b8258f25e70579f1a4c04587'],
])('preserves UTF-8 digest encoding for %j', async (input, expected) => {
	expect(await stringDigest(input)).toBe(expected);
	expect(await enrollmentFingerprint(input)).toBe(expected);
});
