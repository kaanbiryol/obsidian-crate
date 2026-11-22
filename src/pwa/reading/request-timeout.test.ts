import { expect, it } from 'vitest';
import { readingRequestTimeout } from './api';

it('gives large encrypted captures time to upload and extracts time to download', () => {
	expect(readingRequestTimeout('/reading/items')).toBe(20_000);
	// About 12 MB of sealed images needs far longer than the server's 20 seconds on a slow uplink.
	expect(readingRequestTimeout('/reading/encrypted-commit', 'x'.repeat(12 * 1024 * 1024))).toBe(20_000 + 48_000);
	expect(readingRequestTimeout('/reading/encrypted-extract', '{}')).toBe(61_000);
});
