import { createHash } from 'node:crypto';

/**
 * One definition of "the digest of these bytes".
 *
 * The reader computes it when it hands a file over and the writer computes it
 * again when it proves the file has not changed since. Those two must agree
 * byte-for-byte or compare-before-write rejects every write, so the hash is not
 * allowed to be a private detail of either module.
 */
export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}
