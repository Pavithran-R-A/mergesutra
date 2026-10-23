import path from 'node:path';

function refuse() {
  const error = new Error('path escapes the root');
  error.code = 'EPATH';
  throw error;
}

export function resolveInside(root, candidate) {
  if (typeof root !== 'string' || typeof candidate !== 'string') {
    throw new TypeError('root and candidate must be strings');
  }
  if (path.isAbsolute(candidate)) refuse();
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(path.resolve(root), resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    refuse();
  }
  return resolved;
}
