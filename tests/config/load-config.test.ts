import { describe, it, expect } from 'vitest';
import { loadBharatCodeConfig, summarizeConfig } from '../../src/config/load-config.js';
import { AppError } from '../../src/core/errors.js';

describe('loadBharatCodeConfig', () => {
  it('reads credentials and settings from the environment', () => {
    const cfg = loadBharatCodeConfig({
      BHARATCODE_API_KEY: '  sk-test-123  ',
      BHARATCODE_MODEL: 'bc-large',
      BHARATCODE_TIMEOUT_MS: '1234',
      BHARATCODE_MAX_RETRIES: '5',
    });
    expect(cfg.apiKey).toBe('sk-test-123');
    expect(cfg.model).toBe('bc-large');
    expect(cfg.timeoutMs).toBe(1234);
    expect(cfg.retry.maxRetries).toBe(5);
  });

  it('falls back to the documented default base URL', () => {
    const cfg = loadBharatCodeConfig({});
    expect(cfg.baseUrl).toBe('https://bharatcode.ai/api/model/v1');
    expect(cfg.apiKey).toBeUndefined();
  });

  it('accepts an explicit base URL and strips trailing slashes', () => {
    const cfg = loadBharatCodeConfig({ BHARATCODE_API_BASE: 'https://bc.example/v1/' });
    expect(cfg.baseUrl).toBe('https://bc.example/v1');
  });

  it('rejects a malformed base URL with a config error', () => {
    expect(() => loadBharatCodeConfig({ BHARATCODE_API_BASE: 'not a url' })).toThrow(AppError);
  });

  it('rejects a non-http(s) base URL', () => {
    let caught: unknown;
    try {
      loadBharatCodeConfig({ BHARATCODE_API_BASE: 'ftp://x/v1' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).kind).toBe('config');
  });
});

describe('summarizeConfig', () => {
  it('reports configured state without ever exposing the key value', () => {
    const key = 'sk-DO-NOT-LEAK-1234567890';
    const summary = summarizeConfig(loadBharatCodeConfig({ BHARATCODE_API_KEY: key }));
    expect(summary.configured).toBe(true);
    expect(summary.apiKeySource).toBe('environment');
    expect(JSON.stringify(summary)).not.toContain(key);
  });

  it('reports not-configured cleanly', () => {
    const summary = summarizeConfig(loadBharatCodeConfig({}));
    expect(summary.configured).toBe(false);
    expect(summary.apiKeySource).toBe('none');
  });
});
