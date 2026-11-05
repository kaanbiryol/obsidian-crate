import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudflareOperationPresentation } from './operation-presentation';

type FailOptions = { action?: { label: string; onClick: () => void } };

afterEach(() => { vi.unstubAllGlobals(); });

describe('CloudflareOperationPresentation', () => {
	it('links to the account R2 dashboard when R2 is not active', () => {
		const fail = vi.fn<(title: string, description: string, details?: string[], options?: FailOptions) => void>();
		const presentation = new CloudflareOperationPresentation({ setWorking: vi.fn(), fail, succeed: vi.fn() }, {
			intent: null, shouldConnectDevice: true, openSettings: vi.fn(), recoverUpdate: vi.fn(),
		});
		const open = vi.fn();
		vi.stubGlobal('window', { open });

		presentation.operationFailed('R2 is not active', { needsReview: false, canResumeDeletion: false, r2InactiveAccountId: 'abc123' });

		const [title, , , options] = fail.mock.calls[0]!;
		expect(title).toBe('Turn on R2 in Cloudflare');
		expect(options?.action?.label).toBe('Open R2 in Cloudflare');
		options?.action?.onClick();
		expect(open).toHaveBeenCalledWith('https://dash.cloudflare.com/abc123/r2/overview', '_blank', 'noopener,noreferrer');
	});
});
