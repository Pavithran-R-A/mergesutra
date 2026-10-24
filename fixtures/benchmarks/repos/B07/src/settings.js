import process from 'node:process';

const DEFAULTS = { url: 'https://api.example.com', retries: 2, token: '' };

export function loadSettings(options = {}) {
  const env = options.env ?? {};
  const file = options.file ?? {};
  const settings = {
    ...DEFAULTS,
    token: env.BENCH_TOKEN ?? process.env.BENCH_TOKEN ?? DEFAULTS.token,
    url: env.BENCH_URL ?? DEFAULTS.url,
    retries: env.BENCH_RETRIES === undefined ? DEFAULTS.retries : Number(env.BENCH_RETRIES),
    ...file,
  };
  if (settings.retries < 0 || settings.retries > 10) {
    throw new RangeError(`invalid settings: ${JSON.stringify(settings)}`);
  }
  return settings;
}
