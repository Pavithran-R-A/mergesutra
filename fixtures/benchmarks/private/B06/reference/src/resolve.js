import fs from 'node:fs';
import path from 'node:path';

function refuse() {
  const error = new Error('path escapes the root');
  error.code = 'EPATH';
  throw error;
}

function escapesRealRoot(realRoot, target) {
  const relative = path.relative(realRoot, target);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

export function resolveInside(root, candidate) {
  if (typeof root !== 'string' || typeof candidate !== 'string') {
    throw new TypeError('root and candidate must be strings');
  }
  const realRoot = fs.realpathSync(root);
  if (path.isAbsolute(candidate)) refuse();
  const resolved = path.resolve(realRoot, candidate);
  if (escapesRealRoot(realRoot, resolved)) refuse();

  let probe = resolved;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  if (escapesRealRoot(realRoot, fs.realpathSync(probe))) refuse();
  return resolved;
}
