import process from 'node:process';

const DEFAULTS = { url: 'https://api.example.com', retries: 2, token: '' };

function settingsFromEnv(env) {
  const settings = {};
  if (env.BENCH_URL !== undefined) settings.url = env.BENCH_URL;
  if (env.BENCH_RETRIES !== undefined) settings.retries = env.BENCH_RETRIES;
  if (env.BENCH_TOKEN !== undefined) settings.token = env.BENCH_TOKEN;
  return settings;
}

export function loadSettings(options = {}) {
  const env = options.env === undefined ? process.env : options.env;
  const file = options.file ?? {};
  const settings = { ...DEFAULTS, ...file, ...settingsFromEnv(env) };
  const retries =
    typeof settings.retries === 'string' ? Number(settings.retries) : settings.retries;
  if (!Number.isInteger(retries) || retries < 0 || retries > 10) {
    throw new RangeError(`invalid settings: ${JSON.stringify(settings)}`);
  }
  return { ...settings, retries };
}
