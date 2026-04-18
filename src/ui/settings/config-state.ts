import type { SetupWizardState } from './config-types';

export interface ConfigSectionState {
  showCreateToken: boolean;
  showConnectedAccount: boolean;
  showQuickSetup: boolean;
  showDeviceSetup: boolean;
  showResetLocalConfiguration: boolean;
}

export function isWizardReady(wizardState: SetupWizardState): boolean {
  return wizardState.wizardTokenValidated && !!wizardState.wizardSelectedAccountId;
}

export function getConfigSectionState({
  hasCloudflareCredentials,
  isConfigured,
  wizardState,
}: {
  hasCloudflareCredentials: boolean;
  isConfigured: boolean;
  wizardState: SetupWizardState;
}): ConfigSectionState {
  const wizardReady = isWizardReady(wizardState);

  return {
    showCreateToken: !hasCloudflareCredentials && !isConfigured,
    showConnectedAccount: hasCloudflareCredentials,
    showQuickSetup: !isConfigured && (hasCloudflareCredentials || wizardReady),
    showDeviceSetup: isConfigured,
    showResetLocalConfiguration: hasCloudflareCredentials || isConfigured,
  };
}
