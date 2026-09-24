import { describe, it, expect } from 'vitest';
import { Redactor, redactHeader, redactText } from '../../src/security/redaction.js';

const SECRET = 'sk-bharatcode-SUPERSECRETVVALUE-999';

describe('Redactor', () => {
  it('masks a registered secret value wherever it appears', () => {
    const r = new Redactor([SECRET]);
    const out = r.text(`config => ${SECRET} loaded`);
    expect(out).not.toContain(SECRET);
    expect(out).toContain('[REDACTED]');
  });

  it('masks sk- shaped tokens even when not pre-registered', () => {
    const r = new Redactor();
    expect(r.text('key is sk-abcdef123456')).not.toContain('sk-abcdef123456');
  });

  it('masks GitHub token shapes', () => {
    const r = new Redactor();
    expect(r.text('ghp_AAAAAAAAAAAAAAAAAAAA')).not.toContain('ghp_AAAAAAAAAAAAAAAAAAAA');
  });

  it('masks inline NAME=value for known secret env names', () => {
    const r = new Redactor();
    const out = r.text('export BHARATCODE_API_KEY=abc123xyz');
    expect(out).not.toContain('abc123xyz');
  });

  it('always redacts sensitive header values by name', () => {
    expect(redactHeader('Authorization', 'Bearer abc.def')).toBe('[REDACTED]');
    expect(redactHeader('authorization', 'x')).toBe('[REDACTED]');
    expect(redactHeader('content-type', 'application/json')).toBe('application/json');
  });

  it('redacts a headers record', () => {
    const r = new Redactor([SECRET]);
    const out = r.headers({ authorization: `Bearer ${SECRET}`, accept: 'application/json' });
    expect(out.authorization).toBe('[REDACTED]');
    expect(out.accept).toBe('application/json');
  });

  it('deep-redacts secret-ish keys in nested structures', () => {
    const r = new Redactor();
    const out = r.deep({ user: 'bob', api_key: 'leak-me', nested: { token: 'abc' } });
    expect(out.user).toBe('bob');
    expect(out.api_key).toBe('[REDACTED]');
    expect(out.nested.token).toBe('[REDACTED]');
  });

  it('keeps numbers and booleans intact under a secret-ish key name', () => {
    // `promptTokens` is a counter, not a credential. Masking it turned a valid
    // run record into one its own schema refused to read back.
    const r = new Redactor();
    const out = r.deep({ promptTokens: 120, completionTokens: null, retried: false, ok: 1.5 });
    expect(out).toEqual({ promptTokens: 120, completionTokens: null, retried: false, ok: 1.5 });
  });

  it('masks a string hidden under a secret-ish key at any depth', () => {
    const r = new Redactor();
    const out = r.deep({ tokens: { access: 'leak-me', count: 3 } });
    expect(out.tokens).toEqual({ access: '[REDACTED]', count: 3 });
  });

  it('does not crash on empty or short secrets', () => {
    const r = new Redactor(['ab', undefined]);
    expect(() => r.text('nothing here')).not.toThrow();
  });
});

describe('module helpers', () => {
  it('redactText masks a one-off secret list', () => {
    expect(redactText(`token=${SECRET}`, [SECRET])).not.toContain(SECRET);
  });
});
