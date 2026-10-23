export function parsePort(value) {
  const port = Number(value);
  if (port < 1 || port > 65535) {
    throw new RangeError('port must be an integer between 1 and 65535');
  }
  return port;
}
