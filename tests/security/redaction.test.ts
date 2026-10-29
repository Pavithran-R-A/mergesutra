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

  it('masks current BharatCode bc_live_ tokens even when not pre-registered', () => {
    const r = new Redactor();
    expect(r.text('key is bc_live_abcdef123456')).not.toContain('bc_live_abcdef123456');
  });

  it('masks legacy/OpenAI-style sk- tokens even when not pre-registered', () => {
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

describe('credentials embedded in captured text', () => {
  it('masks a quoted JSON key and keeps the document usable', () => {
    // The JSON a command prints is a string leaf by the time it reaches `text()`,
    // so the closing quote after the key name is what the old pattern could not
    // see through: the secret survived in exactly the shape a tool prints it.
    const r = new Redactor();
    const out = r.text('{"password": "hunter2", "user": "bob"}');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('"password": "[REDACTED]"');
    expect(out).toContain('"user": "bob"');
  });

  it('masks quoted keys the vocabulary only recognises by shape', () => {
    const r = new Redactor();
    expect(r.text('{"api_key":"hunter2"}')).not.toContain('hunter2');
    expect(r.text('{"dbPassword":"p@ssw0rd"}')).not.toContain('p@ssw0rd');
  });

  it('masks a raw Authorization header line with an opaque token', () => {
    // A base64/JWT body matches no token shape, and `Authorization` is not in the
    // generic key vocabulary, so this line used to pass through unmasked.
    const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature';
    const out = new Redactor().text(`Authorization: Bearer ${token}`);
    expect(out).not.toContain(token);
    expect(out).toBe('Authorization: [REDACTED]');
  });

  it('masks raw X-Api-Key and Cookie header lines', () => {
    const key = 'ABCDEF123456';
    const cookie = 'session=abc123; theme=dark';
    const out = new Redactor().text(`X-Api-Key: ${key}\nCookie: ${cookie}`);
    expect(out).not.toContain(key);
    expect(out).not.toContain('session=abc123');
    expect(out).toBe('X-Api-Key: [REDACTED]\nCookie: [REDACTED]');
  });

  it('masks a sensitive header name quoted as a JSON key', () => {
    // The whole-tail rule reads flat text, so in a JSON leaf the quote that closes the key
    // name sits between the name and the colon. `"?` is what lets the pattern reach across
    // it: without that branch `Authorization` and `Cookie` are unrecognised key names — they
    // match no generic vocabulary and no token format — and the credential travels whole.
    // The key's own closing quote is part of what the rule keeps; everything after the colon
    // goes, the value's closing quote and the brace with it — the same deliberate
    // over-redaction the raw-line cases above accept for a `Cookie` list.
    const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature';
    const auth = new Redactor().text(`{"Authorization":"Bearer ${token}"}`);
    expect(auth).not.toContain(token);
    expect(auth).toBe('{"Authorization":[REDACTED]');
    expect(new Redactor().text('{"Cookie":"session=abc123; theme=dark"}')).toBe(
      '{"Cookie":[REDACTED]',
    );
  });

  it('masks a Basic credential that has no token-shaped prefix', () => {
    const encoded = 'dXNlcjpwYXNzd29yZA==';
    const out = new Redactor().text(
      `curl -H 'Authorization: Basic ${encoded}' https://api.example/x`,
    );
    expect(out).not.toContain(encoded);
  });

  it('does not duplicate the opening quote of a quoted value', () => {
    expect(new Redactor().text('token = "abc123"')).toBe('token = "[REDACTED]"');
  });
});

describe('module helpers', () => {
  it('redactText masks a one-off secret list', () => {
    expect(redactText(`token=${SECRET}`, [SECRET])).not.toContain(SECRET);
  });
});
