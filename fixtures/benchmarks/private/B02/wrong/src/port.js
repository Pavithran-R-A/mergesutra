export function parsePort(value) {
  const isNumber = typeof value === 'number';
  const isNonEmptyString = typeof value === 'string' && value.trim() !== '';
  if (!isNumber && !isNonEmptyString) {
    throw new TypeError('port must be a number or a numeric string');
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError('port must be an integer between 1 and 65535');
  }
  return port;
}
