export interface SettingsTabModelInput {
	isConfigured: boolean;
	hasDeployment?: boolean;
}

export interface SettingsTabSections {
	showReminders: boolean;
	showSync: boolean;
	showNotifications: boolean;
	showInfrastructure: boolean;
}

export function getSettingsTabSections(input: SettingsTabModelInput): SettingsTabSections {
	const { isConfigured } = input;

	return {
		showReminders: isConfigured,
		showSync: isConfigured,
		showNotifications: isConfigured,
		showInfrastructure: isConfigured || input.hasDeployment === true,
	};
}
