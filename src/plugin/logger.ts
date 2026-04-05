/**
 * Centralized logger with [Crate] [Component] prefix format
 */

export interface Logger {
	debug: (...args: unknown[]) => void;
	info: (...args: unknown[]) => void;
	warn: (...args: unknown[]) => void;
	error: (...args: unknown[]) => void;
}

let debugEnabled = false;

export function configureSyncLogger(config: { enabled: boolean }): void {
	debugEnabled = config.enabled;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createLogger(component: string): Logger {
	const prefix = `[Crate] [${component}]`;

	return {
		debug: (...args: unknown[]) => { if (debugEnabled) console.debug(prefix, ...args); },
		info: (...args: unknown[]) => { if (debugEnabled) console.debug(prefix, ...args); },
		warn: (...args: unknown[]) => console.warn(prefix, ...args),
		error: (...args: unknown[]) => console.error(prefix, ...args),
	};
}
