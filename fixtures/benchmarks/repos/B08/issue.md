# Range helpers accept inverted bounds and describe the clamped value

`src/range.js` and `src/format.js` implement clamping, range membership and a
human-readable description. Inverted bounds silently produce a value instead of an
error, the upper bound cannot be included, and the description reports the clamped
number rather than the number the caller asked about.

Required behaviour:

1. `clamp(value, min, max)` returns `value` when it is inside the range, `min` below
   it and `max` above it.
2. `inRange(value, min, max, options)` keeps the upper bound exclusive by default;
   `options.inclusive === true` includes it.
3. `describeRange(value, min, max, options)` returns
   `<value> inside` or `<value> outside`, using the original `value`, never the
   clamped one. It accepts the same `options` as `inRange`.
4. When `min > max`, `clamp`, `inRange` and `describeRange` each throw a `RangeError`
   whose message is exactly `min must not exceed max`.
5. The behaviour is implemented across both files; a caller importing either module
   must see the corrected contract.

The existing tests must keep passing.
