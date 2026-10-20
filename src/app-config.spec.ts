import { intFromEnv, logLevelsFromEnv } from './app-config.js';

describe('app-config', () => {
  afterEach(() => {
    delete process.env.TEST_INT;
    delete process.env.LOG_LEVEL;
  });

  it('intFromEnv falls back when unset', () => {
    expect(intFromEnv('TEST_INT', 42)).toBe(42);
  });

  it('intFromEnv rejects non-integers', () => {
    process.env.TEST_INT = 'abc';
    expect(() => intFromEnv('TEST_INT', 0)).toThrow('Invalid TEST_INT="abc"');
  });

  it('logLevelsFromEnv includes more severe levels', () => {
    process.env.LOG_LEVEL = 'warn';
    expect(logLevelsFromEnv()).toEqual(['fatal', 'error', 'warn']);
  });

  it('logLevelsFromEnv rejects unknown levels', () => {
    process.env.LOG_LEVEL = 'loud';
    expect(() => logLevelsFromEnv()).toThrow('Invalid LOG_LEVEL');
  });
});
