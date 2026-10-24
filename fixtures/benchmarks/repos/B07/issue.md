# loadSettings resolves precedence backwards and hides bad values

`loadSettings({ env, file })` builds the runtime configuration. It is documented as
defaults < file < environment, but the current merge lets a file value win over an
environment value, accepts values it should refuse, and copies a token into error
messages.

Required behaviour:

1. Defaults are `{ url: 'https://api.example.com', retries: 2, token: '' }`.
2. A value in `file` overrides the default; a value in `env` overrides `file`.
   Environment variables are `BENCH_URL`, `BENCH_RETRIES` and `BENCH_TOKEN`.
3. When an `env` object is supplied, `process.env` is not read at all. When it is
   not supplied, `process.env` is the environment.
4. `retries` must be an integer from `0` to `10` inclusive; a numeric string is
   accepted. Otherwise a `RangeError` with the message exactly
   `retries must be an integer between 0 and 10` is thrown.
5. `url` must be a string starting with `https://`, otherwise a `TypeError` with
   the message exactly `url must be an https URL` is thrown.
6. No error message may contain the token value.

The existing tests must keep passing.
