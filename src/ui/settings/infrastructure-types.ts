import type CratePlugin from '../../main';

interface CloudflareCredentials {
	accountId: string;
	apiToken: string;
}

export interface ResolveCredentialResult {
	credentials: CloudflareCredentials | null;
	hadError: boolean;
}

export interface InfrastructureSectionContext {
	containerEl: HTMLElement;
	plugin: CratePlugin;
	isConfigured: boolean;
	rerender: () => void;
}
