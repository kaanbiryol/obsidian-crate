import { describe, expect, it } from 'vitest';
import { generateSecureToken, hashToken } from './device-token';

describe('device tokens', () => {
	it('generates 256-bit hexadecimal secrets', () => {
		const first = generateSecureToken();
		const second = generateSecureToken();

		expect(first).toMatch(/^[a-f0-9]{64}$/);
		expect(second).toMatch(/^[a-f0-9]{64}$/);
		expect(second).not.toBe(first);
	});

	it('hashes tokens as SHA-256 hexadecimal values', async () => {
		await expect(hashToken('crate')).resolves.toBe(
			'f5fe331d2367a7a67ee20bd579c77b929ae49439d8b0d8e9c3b98609797b6b69',
		);
	});
});
