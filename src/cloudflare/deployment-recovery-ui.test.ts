import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
    modal: { setWorking: vi.fn(), fail: vi.fn(), succeed: vi.fn() },
    start: vi.fn(),
    reveal: vi.fn(() => false),
    copy: vi.fn(async (_text: string) => {}),
}));
vi.mock('obsidian', () => ({ Notice: class {} }));
vi.mock('../ui/cloudflare-deployment-modal', () => ({ openCloudflareDeploymentModal: () => mocks.modal, revealCloudflareOperation: mocks.reveal }));
vi.mock('./plugin-integration', () => ({ startCloudflareDeployment: mocks.start }));
import { checkAndRecoverUpdate } from './deployment-recovery-ui';
import { DeploymentRecoveryRequiredError } from './deployment-fence';

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });
function plugin(status: 'blocked' | 'recovered') {
    return {
        app: {},
        getSettingsDocument: () => undefined,
        refreshSettingsTab: vi.fn(),
        cloudflareUsageConnection: { withAuthorization: vi.fn() },
        cloudflareDeploymentService: {
            recoverUpdate: vi.fn(async () => ({ status, message: 'Result', diagnostics: '{"step":"upload-worker"}' })),
        },
    };
}
it('offers a fresh check and cancel without asking users to attest upload safety', async () => {
    const instance = plugin('blocked');
    await checkAndRecoverUpdate(instance as never);
    const options = mocks.modal.fail.mock.calls[0]?.[3] as { dismissLabel: string; technicalDetails: string; action: { label: string; onClick(): void } };
    expect(options.dismissLabel).toBe('Cancel');
    expect(options.technicalDetails).toBe('{"step":"upload-worker"}');
    expect(options.action.label).toBe('Check again');
    options.action.onClick();
    await vi.waitFor(() => expect(instance.cloudflareDeploymentService.recoverUpdate).toHaveBeenCalledTimes(2));
    expect(instance.cloudflareDeploymentService.recoverUpdate).toHaveBeenLastCalledWith(expect.any(Function));
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


it('reveals a running operation instead of starting recovery concurrently', async () => {
    const instance = plugin('recovered');
    mocks.reveal.mockReturnValueOnce(true);
    await checkAndRecoverUpdate(instance as never);
    expect(instance.cloudflareDeploymentService.recoverUpdate).not.toHaveBeenCalled();
});
