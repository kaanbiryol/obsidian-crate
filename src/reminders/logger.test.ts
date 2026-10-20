import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configureLogger, createLogger } from './logger';

beforeEach(() => {
  configureLogger({ enabled: false, minLevel: 'debug', prefix: 'Crate' });
  vi.restoreAllMocks();
});

describe('reminders logger', () => {
  it('keeps debug output disabled by default', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});

    createLogger('Test').debug('details');

    expect(debug).not.toHaveBeenCalled();
  });

  it('always reports warnings and errors', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createLogger('Test');

    logger.warn('warning');
    logger.error('failure');

    expect(warn).toHaveBeenCalledWith('[Crate] [Test]', 'warning');
    expect(error).toHaveBeenCalledWith('[Crate] [Test]', 'failure');
  });
});
