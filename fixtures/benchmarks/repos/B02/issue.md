# parsePort accepts values it should reject

`parsePort` reads a port number from configuration. It currently converts
anything `Number` accepts and only checks the range.

Required behaviour:

1. A number or a string of ASCII digits (one or more) is a candidate.
2. A candidate that is not an integer, or is outside 1–65535 inclusive, throws
   a `RangeError` whose message is exactly
   `port must be an integer between 1 and 65535`.
3. Any other value (including an empty string, a hexadecimal string, an
   exponent string, `null`, `true` or an array) throws a `TypeError` whose
   message is exactly `port must be a number or a numeric string`.
4. A valid candidate is returned as a number.

The existing tests must keep passing.
