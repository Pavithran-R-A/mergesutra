export function encodeRecord(record) {
  return Object.entries(record)
    .map(([key, value]) => `${key}=${value}`)
    .join(';');
}

export function decodeRecord(text) {
  const record = {};
  for (const pair of text.split(';')) {
    const [key, value] = pair.split('=');
    record[key] = value;
  }
  return record;
}
