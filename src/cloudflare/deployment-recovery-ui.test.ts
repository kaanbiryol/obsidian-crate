import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
    modal: { setWorking: vi.fn(), fail: vi.fn(), succeed: vi.fn() },
    start: vi.fn(),
    copy: vi.fn(async (_text: string) => {}),
}));
vi.mock('obsidian', () => ({ Notice: class {} }));
vi.mock('../ui/cloudflare-deployment-modal', () => ({ openCloudflareDeploymentModal: () => mocks.modal }));
vi.mock('./plugin-integration', () => ({ startCloudflareDeployment: mocks.start }));
import { checkAndRecoverUpdate } from './deployment-recovery-ui';
import { DeploymentRecoveryRequiredError } from './deployment-fence';

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });
function plugin(status: 'blocked' | 'recovered') {
    return {
        app: {},
        refreshSettingsTab: vi.fn(),
        cloudflareUsageConnection: { withAuthorization: vi.fn() },
        cloudflareDeploymentService: {
            recoverUpdate: vi.fn(async () => ({ status, message: 'Result', diagnostics: '{"step":"upload-worker"}' })),
        },
    };
}
it('offers diagnostics without retrying an uncertain update', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: mocks.copy } });
    await checkAndRecoverUpdate(plugin('blocked') as never);
    const options = mocks.modal.fail.mock.calls[0]?.[3] as { action: { label: string; onClick(): void } };
    expect(options.action.label).toBe('Copy diagnostics');
    options.action.onClick();
    expect(mocks.copy).toHaveBeenCalledWith('{"step":"upload-worker"}');
    expect(mocks.start).not.toHaveBeenCalled();
});
it('offers an explicit update after successful recovery', async () => {
    const instance = plugin('recovered');
    await checkAndRecoverUpdate(instance as never);
    const options = mocks.modal.succeed.mock.calls[0]?.[2] as { action: { label: string; onClick(): void } };
    expect(options.action.label).toBe('Update server');
    expect(mocks.start).not.toHaveBeenCalled();
    options.action.onClick();
    expect(mocks.start).toHaveBeenCalledWith(instance, 'update');
});

it('explains a retained verification lock without misreporting it as a network failure', async () => {
    const instance = plugin('recovered');
    instance.cloudflareDeploymentService.recoverUpdate.mockRejectedValue(new DeploymentRecoveryRequiredError('Public fingerprint mismatch'));
    await checkAndRecoverUpdate(instance as never);
    expect(mocks.modal.fail).toHaveBeenCalledWith('Could not check the server', expect.stringContaining('lock remains held'), undefined,
        { technicalDetails: 'Public fingerprint mismatch' });
});
