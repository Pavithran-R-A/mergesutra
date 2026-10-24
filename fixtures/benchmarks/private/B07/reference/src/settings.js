import process from 'node:process';

const DEFAULTS = { url: 'https://api.example.com', retries: 2, token: '' };

function settingsFromEnv(env) {
  const settings = {};
  if (env.BENCH_URL !== undefined) settings.url = env.BENCH_URL;
  if (env.BENCH_RETRIES !== undefined) settings.retries = env.BENCH_RETRIES;
  if (env.BENCH_TOKEN !== undefined) settings.token = env.BENCH_TOKEN;
  return settings;
}

function validate(settings) {
  if (typeof settings.url !== 'string' || !settings.url.startsWith('https://')) {
    throw new TypeError('url must be an https URL');
  }
  const retries =
    typeof settings.retries === 'string' ? Number(settings.retries) : settings.retries;
  if (!Number.isInteger(retries) || retries < 0 || retries > 10) {
    throw new RangeError('retries must be an integer between 0 and 10');
  }
  return { url: settings.url, retries, token: settings.token };
}

export function loadSettings(options = {}) {
  const env = options.env === undefined ? process.env : options.env;
  const file = options.file ?? {};
  return validate({ ...DEFAULTS, ...file, ...settingsFromEnv(env) });
}
