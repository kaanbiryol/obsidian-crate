import {
	configureLogger,
	createScopedLogger,
	type Logger,
} from '../platform/logger';

export type { Logger } from '../platform/logger';

export function configureSyncLogger(config: { enabled: boolean }): void {
	configureLogger('sync', config);
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createLogger(component: string): Logger {
	return createScopedLogger('sync', component);
}
