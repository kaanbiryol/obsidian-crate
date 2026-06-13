/**
 * Centralized logging utility with configurable enabled state.
 *
 * Usage:
 * 1. Configure globally (once per app on init):
 *    configureLogger({ enabled: true, prefix: 'Reminders' })
 *
 * 2. Create named loggers in each module:
 *    const log = createLogger('ServiceName');
 *    log.info('message', data);
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LoggerConfig {
  enabled: boolean;
  minLevel?: LogLevel;
  prefix?: string;
}

let globalConfig: LoggerConfig = {
  enabled: true,
  minLevel: 'debug',
};

/**
 * Configure the global logger settings.
 * Call this on app initialization to control logging behavior.
 */
export function configureLogger(config: Partial<LoggerConfig>): void {
  globalConfig = { ...globalConfig, ...config };
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

function shouldLog(level: LogLevel): boolean {
  if (!globalConfig.enabled) return false;
  const minPriority = LOG_LEVEL_PRIORITY[globalConfig.minLevel || 'debug'];
  return LOG_LEVEL_PRIORITY[level] >= minPriority;
}

function getPrefix(serviceName: string): string {
  return globalConfig.prefix
    ? `[${globalConfig.prefix}] [${serviceName}]`
    : `[${serviceName}]`;
}

/**
 * Create a named logger instance.
 * The service name is automatically prefixed to all log messages.
 *
 * @param serviceName - Name to prefix log messages with, e.g., 'CalDAV'
 * @returns Logger instance with debug, info, warn, and error methods
 */
export function createLogger(serviceName: string): Logger {
  return {
    debug(...args: unknown[]) {
      if (shouldLog('debug')) {
        console.debug(getPrefix(serviceName), ...args);
      }
    },
    info(...args: unknown[]) {
      if (shouldLog('info')) {
        console.debug(getPrefix(serviceName), ...args);
      }
    },
    warn(...args: unknown[]) {
      if (shouldLog('warn')) {
        console.warn(getPrefix(serviceName), ...args);
      }
    },
    error(...args: unknown[]) {
      if (shouldLog('error')) {
        console.error(getPrefix(serviceName), ...args);
      }
    },
  };
}
