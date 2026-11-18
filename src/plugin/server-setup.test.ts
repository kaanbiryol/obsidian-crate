import { afterEach, describe, expect, it, vi } from 'vitest';
import type CratePlugin from './CratePlugin';
import { ensureServerSetup, serverSetupIssues } from './server-setup';
import { refreshSharedFeatures } from './feature-settings';
import { ensureReminderNotificationPolicy } from '../reminders/notification-policy-sync';
import { checkReadingSetup, ReadingSetupBusyError } from '../reading/runtime';
import { HttpError, SyncTransportError } from '../sync/worker-api/http';

vi.mock('./feature-settings', () => ({ refreshSharedFeatures: vi.fn(async () => {}) }));
vi.mock('../reminders/notification-policy-sync', () => ({ ensureReminderNotificationPolicy: vi.fn(async () => {}) }));
vi.mock('../reading/runtime', () => ({
	checkReadingSetup: vi.fn(async () => {}),
	ReadingSetupBusyError: class extends Error { constructor() { super('Sync is updating files. Try again when it finishes.'); } },
}));

const refreshSettingsTab = vi.fn();
function plugin(workerUrl = 'https://server.example') {
	return { settings: { workerUrl }, syncRuntime: { isConfigured: () => !!workerUrl }, refreshSettingsTab } as unknown as CratePlugin;
}
afterEach(() => { vi.clearAllMocks(); });

describe('server setup check', () => {
	it('runs every step, keeps each failure and clears it once a later run succeeds', async () => {
		const host = plugin();
		vi.mocked(refreshSharedFeatures).mockRejectedValueOnce(new Error('Could not read shared feature settings.'));
		vi.mocked(checkReadingSetup).mockRejectedValueOnce(new Error('Encrypted sync is not ready.'));
		await ensureServerSetup(host);
		expect(ensureReminderNotificationPolicy).toHaveBeenCalledWith(host, true);
		expect(serverSetupIssues(host)).toEqual([
			{ step: 'features', message: 'Could not read shared feature settings.' },
			{ step: 'reading', message: 'Encrypted sync is not ready.' },
		]);
		expect(refreshSettingsTab).toHaveBeenCalledOnce();
		await ensureServerSetup(host);
		expect(serverSetupIssues(host)).toEqual([]);
		expect(refreshSettingsTab).toHaveBeenCalledTimes(2);
		// An unchanged result does not rebuild the settings tab.
		await ensureServerSetup(host);
		expect(refreshSettingsTab).toHaveBeenCalledTimes(2);
	});
	it('drops a result for a server this device has since left', async () => {
		const host = plugin();
		vi.mocked(checkReadingSetup).mockImplementationOnce(async () => {
			host.settings.workerUrl = 'https://replacement.example';
			throw new Error('old server');
		});
		await expect(ensureServerSetup(host)).resolves.toEqual({ issues: [], unreachable: false });
		expect(serverSetupIssues(host)).toEqual([]);
	});
	it('shows nothing for a previous server after switching', async () => {
		const host = plugin();
		vi.mocked(checkReadingSetup).mockRejectedValueOnce(new Error('failed'));
		await ensureServerSetup(host);
		expect(serverSetupIssues(host)).toHaveLength(1);
		host.settings.workerUrl = 'https://replacement.example';
		expect(serverSetupIssues(host)).toEqual([]);
	});
	it('keeps an earlier answer when the server cannot be reached, and says so', async () => {
		const host = plugin();
		vi.mocked(checkReadingSetup).mockRejectedValueOnce(new Error('Encrypted sync is not ready.'));
		await ensureServerSetup(host);
		vi.mocked(checkReadingSetup).mockRejectedValueOnce(new SyncTransportError('offline'));
		vi.mocked(refreshSharedFeatures).mockRejectedValueOnce(new HttpError('Server busy', 503));
		await expect(ensureServerSetup(host)).resolves.toEqual({
			issues: [{ step: 'reading', message: 'Encrypted sync is not ready.' }], unreachable: true,
		});
	});
	it('defers a Reading check while sync writes files, keeping its earlier answer', async () => {
		const host = plugin();
		vi.mocked(checkReadingSetup).mockRejectedValueOnce(new Error('Encrypted sync is not ready.'));
		await ensureServerSetup(host);
		vi.mocked(checkReadingSetup).mockRejectedValueOnce(new ReadingSetupBusyError());
		await expect(ensureServerSetup(host)).resolves.toEqual({
			issues: [{ step: 'reading', message: 'Encrypted sync is not ready.' }], unreachable: false,
			deferred: 'Sync is updating files. Try again when it finishes.',
		});
	});
	it('runs overlapping checks one after another, so an older run never restores a cleared issue', async () => {
		const host = plugin();
		vi.mocked(ensureReminderNotificationPolicy).mockRejectedValueOnce(new Error('Policy rejected.'));
		await ensureServerSetup(host);
		let release!: () => void;
		vi.mocked(ensureReminderNotificationPolicy).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
		vi.mocked(ensureReminderNotificationPolicy).mockRejectedValueOnce(new SyncTransportError('offline'));
		// The first run clears the issue; the second, unreachable, starts from that cleared answer.
		const first = ensureServerSetup(host), second = ensureServerSetup(host);
		await vi.waitFor(() => expect(release).toBeTypeOf('function'));
		release();
		await first;
		await expect(second).resolves.toEqual({ issues: [], unreachable: true });
		expect(serverSetupIssues(host)).toEqual([]);
	});
	it('does nothing without a connected server', async () => {
		await ensureServerSetup(plugin(''));
		expect(refreshSharedFeatures).not.toHaveBeenCalled();
	});
});
