/**
 * Prevent the model from silently removing existing executable assertions in
 * a full-file write. This is a conservative preservation check, not a test
 * runner, parser, or claim of acceptance. A human must review intentional
 * changes to old assertions rather than letting a model waive the guard.
 */
export function missingExistingAssertions(before: string, after: string): number {
  const baseline = countAssertions(before);
  const candidate = countAssertions(after);
  let missing = 0;
  for (const [fingerprint, count] of baseline) {
    missing += Math.max(0, count - (candidate.get(fingerprint) ?? 0));
  }
  return missing;
}

function countAssertions(source: string): Map<string, number> {
  const code = maskLiteralsAndComments(source);
  const result = new Map<string, number>();
  const pattern = /\b(?:assert(?:\.[a-zA-Z_$][\w$]*)*|expect)\s*\(/g;
  for (const match of code.matchAll(pattern)) {
    const initialOpen = match.index + match[0].lastIndexOf('(');
    const close = endOfCall(code, initialOpen);
    if (close === null) continue;
    let end = close + 1;
    // The matcher must survive too, not only the initial expect(value) call.
    if (match[0].startsWith('expect')) {
      while (true) {
        const property = /^\s*\.\s*[a-zA-Z_$][\w$]*/.exec(code.slice(end));
        if (!property) break;
        end += property[0].length;
        const nextCall = /^\s*\(/.exec(code.slice(end));
        if (nextCall) {
          const chainClose = endOfCall(code, end + nextCall[0].lastIndexOf('('));
          if (chainClose === null) break;
          end = chainClose + 1;
        }
      }
    }
    const fingerprint = stripTrivia(source.slice(match.index, end));
    result.set(fingerprint, (result.get(fingerprint) ?? 0) + 1);
  }
  return result;
}

/** Mask comments and strings while retaining the offsets of real code. */
function maskLiteralsAndComments(source: string): string {
  const chars = source.split('');
  let index = 0;
  while (index < chars.length) {
    const ch = source[index];
    const next = source[index + 1];
    if (ch === '/' && (next === '/' || next === '*')) {
      const lineComment = next === '/';
      chars[index++] = ' ';
      chars[index++] = ' ';
      while (index < chars.length) {
        if (lineComment && source[index] === '\n') break;
        if (!lineComment && source[index] === '*' && source[index + 1] === '/') {
          chars[index++] = ' ';
          chars[index++] = ' ';
          break;
        }
        if (source[index] !== '\n') chars[index] = ' ';
        index++;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '\x60') {
      const quote = ch;
      chars[index++] = ' ';
      while (index < chars.length) {
        const current = source[index];
        chars[index++] = current === '\n' ? '\n' : ' ';
        if (current === '\\') {
          if (index < chars.length) chars[index++] = ' ';
        } else if (current === quote) break;
      }
      continue;
    }
    index++;
  }
  return chars.join('');
}

function endOfCall(code: string, open: number): number | null {
  if (code[open] !== '(') return null;
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') depth++;
    if (code[i] === ')' && --depth === 0) return i;
  }
  return null;
}

/** Ignore layout/comments but keep the exact input string contents. */
function stripTrivia(source: string): string {
  let result = '';
  let quote: string | null = null;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i] ?? '';
    if (quote !== null) {
      result += ch;
      if (ch === '\\' && i + 1 < source.length) result += source[++i];
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === '\x60') {
      quote = ch;
      result += ch;
    } else if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i++;
    } else if (!/\s/.test(ch)) {
      result += ch;
    }
  }
  return result;
}
