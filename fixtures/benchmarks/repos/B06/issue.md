# resolveInside lets paths and links leave the root

`resolveInside(root, candidate)` is meant to be the one place that turns a
repository-relative path into an absolute path, refusing anything that could land
outside `root`. It currently calls `path.resolve` and returns whatever comes out.

Required behaviour:

1. A relative candidate that stays inside `root` returns an absolute path under
   `root`.
2. A candidate that climbs out with `..` is refused with an `Error` whose
   `code` is exactly `EPATH` and whose message is exactly
   `path escapes the root`.
3. An absolute candidate is refused the same way, even when it happens to point
   inside the root.
4. A link inside `root` that resolves outside it is refused the same way. A link
   that resolves to another directory still inside `root` is allowed.
5. A non-string `root` or `candidate` throws a `TypeError` whose message is
   exactly `root and candidate must be strings`.

The existing tests must keep passing.
