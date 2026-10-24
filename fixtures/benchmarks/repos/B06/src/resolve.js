import path from 'node:path';

export function resolveInside(root, candidate) {
  return path.resolve(root, candidate);
}
