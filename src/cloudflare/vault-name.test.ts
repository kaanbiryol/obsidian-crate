import { describe, expect, it } from 'vitest';
import { normalizeVaultName, readVaultName, vaultChoiceLabel } from './vault-name';
import type { CloudflareDeploymentMetadata } from './deployment-types';

const choice = (id: string, vaultName?: string) => ({ deploymentId: id, vaultName }) as CloudflareDeploymentMetadata;

describe('vault display names', () => {
	it('keeps Unicode names and bounds untrusted labels', () => {
		expect(normalizeVaultName('  Kaan’s notes 📚  ')).toBe('Kaan’s notes 📚');
		expect(normalizeVaultName('a\nb')).toBe('a b');
		expect(normalizeVaultName('x'.repeat(200))).toHaveLength(160);
		expect(normalizeVaultName({})).toBeUndefined();
	});

	it('uses the saved name, distinguishes duplicates, and labels old servers honestly', () => {
		const notes = choice('0123456789abcdef', 'Notes');
		const other = choice('fedcba9876543210', 'Notes');
		expect(vaultChoiceLabel(notes, [notes])).toBe('Notes');
		expect(vaultChoiceLabel(notes, [notes, other])).toBe('Notes (abcdef)');
		expect(vaultChoiceLabel(other, [notes, other])).toBe('Notes (543210)');
		expect(vaultChoiceLabel(choice('0123456789abcdef'), [])).toBe('Unnamed vault (abcdef)');
		expect(readVaultName({ bindings: [] })).toBeUndefined();
	});
});
