# encodeRecord does not escape separators or order its keys

Records are stored as a single line of text: `key=value;key=value`. The current
encoder joins whatever the object holds, so a value containing `;`, `=` or a
newline corrupts the record, and the key order depends on insertion order.

Required behaviour:

1. Keys are emitted in ascending code-unit order.
2. `\`, `;`, `=` and newline are escaped as `\\`, `\;`, `\=`, `\n` in both keys
   and values; `decodeRecord` reverses them exactly.
3. `encodeRecord({})` is the empty string; `decodeRecord('')` is `{}`.
4. `decodeRecord` throws a `SyntaxError` whose message is exactly
   `invalid record` for input that is not a string, a pair without `=`, an empty
   key, a trailing separator, a second unescaped `=`, an unknown escape, or a
   dangling backslash.
5. `encodeRecord` throws a `TypeError` with the message exactly
   `record must be a plain object` for `null`, an array or a non-object, a
   `TypeError` with the message exactly `keys must be non-empty strings` for an
   empty key, and a `TypeError` with the message exactly `values must be strings`
   for a non-string value.

The existing tests must keep passing.
