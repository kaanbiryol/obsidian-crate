/**
 * Centralized logger with [Crate] [Component] prefix format
 */

export interface Logger {
	debug: (...args: unknown[]) => void;
	info: (...args: unknown[]) => void;
	warn: (...args: unknown[]) => void;
	error: (...args: unknown[]) => void;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createLogger(component: string): Logger {
	const prefix = `[Crate] [${component}]`;

	return {
		debug: (...args: unknown[]) => console.debug(prefix, ...args),
		info: (...args: unknown[]) => console.debug(prefix, ...args),
		warn: (...args: unknown[]) => console.warn(prefix, ...args),
		error: (...args: unknown[]) => console.error(prefix, ...args),
	};
}
