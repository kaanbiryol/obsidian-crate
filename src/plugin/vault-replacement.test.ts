import { expect, it, vi } from 'vitest';
import { confirmVaultReplacement } from './vault-replacement';

const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../ui/confirmation-modal', () => ({ openConfirmationModal: confirm }));

it('asks when the server contents cannot be read', async () => {
	await expect(confirmVaultReplacement({} as never, { hasFiles: async () => { throw new Error('offline'); } })).resolves.toBe(true);
	expect(confirm).toHaveBeenCalledOnce();
});
