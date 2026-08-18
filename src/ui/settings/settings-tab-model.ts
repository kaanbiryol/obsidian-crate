export interface SettingsTabModelInput {
	isConfigured: boolean;
}

export interface SettingsTabSections {
	showSync: boolean;
	showNotifications: boolean;
	showInfrastructure: boolean;
}

export function getSettingsTabSections(input: SettingsTabModelInput): SettingsTabSections {
	const { isConfigured } = input;

	return {
		showSync: isConfigured,
		showNotifications: isConfigured,
		showInfrastructure: isConfigured,
	};
}
