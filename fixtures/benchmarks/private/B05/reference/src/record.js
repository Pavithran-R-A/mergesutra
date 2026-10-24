function escapeText(text) {
  let escaped = '';
  for (const char of text) {
    if (char === '\\') escaped += '\\\\';
    else if (char === ';') escaped += '\\;';
    else if (char === '=') escaped += '\\=';
    else if (char === '\n') escaped += '\\n';
    else escaped += char;
  }
  return escaped;
}

function unescapeChar(char) {
  if (char === '\\') return '\\';
  if (char === ';') return ';';
  if (char === '=') return '=';
  if (char === 'n') return '\n';
  throw new SyntaxError('invalid record');
}

export function encodeRecord(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('record must be a plain object');
  }
  return Object.keys(record)
    .sort()
    .map((key) => {
      if (key === '') throw new TypeError('keys must be non-empty strings');
      if (typeof record[key] !== 'string') throw new TypeError('values must be strings');
      return `${escapeText(key)}=${escapeText(record[key])}`;
    })
    .join(';');
}

export function decodeRecord(text) {
  if (typeof text !== 'string') throw new SyntaxError('invalid record');
  const record = {};
  if (text === '') return record;

  const pairs = [];
  let current = '';
  let escaped = false;
  for (const char of text) {
    if (escaped) {
      current += `\\${char}`;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === ';') {
      pairs.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (escaped) throw new SyntaxError('invalid record');
  pairs.push(current);

  for (const pair of pairs) {
    let key = '';
    let value = '';
    let inValue = false;
    let escaping = false;
    for (const char of pair) {
      if (escaping) {
        const decoded = unescapeChar(char);
        if (inValue) value += decoded;
        else key += decoded;
        escaping = false;
        continue;
      }
      if (char === '\\') {
        escaping = true;
        continue;
      }
      if (char === '=') {
        if (inValue) throw new SyntaxError('invalid record');
        inValue = true;
        continue;
      }
      if (inValue) value += char;
      else key += char;
    }
    if (escaping || !inValue || key === '') throw new SyntaxError('invalid record');
    record[key] = value;
  }
  return record;
}
