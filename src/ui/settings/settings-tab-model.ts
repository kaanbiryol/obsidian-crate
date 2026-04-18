export interface SettingsTabModelInput {
	isConfigured: boolean;
	hasCloudflareCredentials: boolean;
}

export interface SettingsTabSections {
	showSync: boolean;
	showNotifications: boolean;
	showUsage: boolean;
	showInfrastructure: boolean;
}

export function getSettingsTabSections(input: SettingsTabModelInput): SettingsTabSections {
	const { isConfigured, hasCloudflareCredentials } = input;

	return {
		showSync: isConfigured,
		showNotifications: isConfigured,
		showUsage: isConfigured,
		showInfrastructure: isConfigured || hasCloudflareCredentials,
	};
}
