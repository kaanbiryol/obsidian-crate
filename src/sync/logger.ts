import {
	configureLogger,
	createScopedLogger,
	type Logger,
} from '../platform/logger';

export type { Logger } from '../platform/logger';

export function configureSyncLogger(config: { enabled: boolean }): void {
	configureLogger('sync', config);
}

export function createLogger(component: string): Logger {
	return createScopedLogger('sync', component);
}
