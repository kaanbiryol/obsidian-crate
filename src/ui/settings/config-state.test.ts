import { describe, expect, it } from 'vitest';
import { getConfigSectionState, isWizardReady } from './config-state';

describe('config section state', () => {
	it('treats only validated wizard selections as setup-ready', () => {
		expect(isWizardReady({
			wizardToken: 'token',
			wizardTokenValidated: true,
			wizardSelectedAccountId: 'acct-1',
		})).toBe(true);

		expect(isWizardReady({
			wizardToken: 'token',
			wizardTokenValidated: false,
			wizardSelectedAccountId: 'acct-1',
		})).toBe(false);
	});

	it('shows token creation when there are no saved credentials and sync is not configured', () => {
		expect(getConfigSectionState({
			hasCloudflareCredentials: false,
			isConfigured: false,
			wizardState: {
				wizardToken: '',
				wizardTokenValidated: false,
				wizardSelectedAccountId: '',
			},
		})).toEqual({
			showCreateToken: true,
			showConnectedAccount: false,
			showQuickSetup: false,
			showDeviceSetup: false,
			showResetLocalConfiguration: false,
		});
	});

	it('shows quick setup and reset actions when the wizard is ready but sync is not configured', () => {
		expect(getConfigSectionState({
			hasCloudflareCredentials: false,
			isConfigured: false,
			wizardState: {
				wizardToken: 'token',
				wizardTokenValidated: true,
				wizardSelectedAccountId: 'acct-1',
			},
		})).toEqual({
			showCreateToken: true,
			showConnectedAccount: false,
			showQuickSetup: true,
			showDeviceSetup: false,
			showResetLocalConfiguration: false,
		});
	});

	it('shows connected-account and device setup actions once the plugin is configured', () => {
		expect(getConfigSectionState({
			hasCloudflareCredentials: true,
			isConfigured: true,
			wizardState: {
				wizardToken: '',
				wizardTokenValidated: false,
				wizardSelectedAccountId: '',
			},
		})).toEqual({
			showCreateToken: false,
			showConnectedAccount: true,
			showQuickSetup: false,
			showDeviceSetup: true,
			showResetLocalConfiguration: true,
		});
	});
});
