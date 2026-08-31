type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
	debug: (...args: unknown[]) => void;
	info: (...args: unknown[]) => void;
	warn: (...args: unknown[]) => void;
	error: (...args: unknown[]) => void;
}

export interface LoggerConfig {
	enabled: boolean;
	minLevel: LogLevel;
	prefix: string;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

const configurations = new Map<string, LoggerConfig>();

function getConfiguration(scope: string): LoggerConfig {
	return configurations.get(scope) ?? {
		enabled: false,
		minLevel: 'debug',
		prefix: 'Crate',
	};
}

export function configureLogger(scope: string, update: Partial<LoggerConfig>): void {
	configurations.set(scope, {
		...getConfiguration(scope),
		...update,
	});
}

function shouldLog(configuration: LoggerConfig, level: LogLevel): boolean {
	if (level === 'warn' || level === 'error') return true;
	return configuration.enabled
		&& LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[configuration.minLevel];
}

export function createScopedLogger(scope: string, component: string): Logger {
	const log = (level: LogLevel, args: unknown[]): void => {
		const configuration = getConfiguration(scope);
		if (!shouldLog(configuration, level)) return;
		const prefix = `[${configuration.prefix}] [${component}]`;
		switch (level) {
			case 'debug':
			case 'info':
				console.debug(prefix, ...args);
				break;
			case 'warn':
				console.warn(prefix, ...args);
				break;
			case 'error':
				console.error(prefix, ...args);
				break;
		}
	};

	return {
		debug: (...args) => log('debug', args),
		info: (...args) => log('info', args),
		warn: (...args) => log('warn', args),
		error: (...args) => log('error', args),
	};
}
