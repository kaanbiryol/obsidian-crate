import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configureLogger, createScopedLogger } from './logger';

beforeEach(() => {
	configureLogger('sync', { enabled: false, minLevel: 'debug', prefix: 'Crate' });
	configureLogger('reminders', { enabled: false, minLevel: 'debug', prefix: 'Crate' });
	vi.restoreAllMocks();
});

describe('scoped logger', () => {
	it('keeps debug settings isolated by feature', () => {
		const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
		configureLogger('sync', { enabled: true });

		createScopedLogger('sync', 'Sync').info('visible');
		createScopedLogger('reminders', 'Reminders').info('hidden');

		expect(debug).toHaveBeenCalledTimes(1);
		expect(debug).toHaveBeenCalledWith('[Crate] [Sync]', 'visible');
	});

	it('always emits warnings and errors', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const logger = createScopedLogger('sync', 'Sync');

		logger.warn('warning');
		logger.error('failure');

		expect(warn).toHaveBeenCalledWith('[Crate] [Sync]', 'warning');
		expect(error).toHaveBeenCalledWith('[Crate] [Sync]', 'failure');
	});
});
