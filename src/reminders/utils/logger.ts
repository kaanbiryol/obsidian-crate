import {
	configureLogger as configureScopedLogger,
	createScopedLogger,
	type Logger,
	type LoggerConfig as ScopedLoggerConfig,
} from '../../platform/logger';

export type { Logger } from '../../platform/logger';

export type LoggerConfig = Partial<Pick<ScopedLoggerConfig, 'minLevel' | 'prefix'>> & {
	enabled: boolean;
};

export function configureLogger(config: Partial<LoggerConfig>): void {
	configureScopedLogger('reminders', config);
}

export function createLogger(serviceName: string): Logger {
	return createScopedLogger('reminders', serviceName);
}
