# truncate splits emoji and ignores the suffix when deciding what fits

`truncate(text, max, suffix)` shortens text so that the result is at most `max`
UTF-16 code units, including the suffix. The current implementation slices by code
unit, which can cut a surrogate pair in half, and it does not validate its inputs.

Required behaviour:

1. Text already within `max` is returned unchanged.
2. Otherwise the result is `kept + suffix`, and its length never exceeds `max`.
3. A surrogate pair is never split: the kept prefix ends on a code-point boundary.
4. `suffix` counts toward the budget.
5. When truncation is required and the suffix alone is at least `max` long, a
   `RangeError` whose message is exactly `max is too small for the suffix` is thrown.
6. A non-string `text` throws a `TypeError` whose message is exactly
   `text must be a string`; a non-string `suffix` throws a `TypeError` whose message
   is exactly `suffix must be a string`; `max` must be an integer of at least `1`,
   otherwise a `RangeError` whose message is exactly
   `max must be a positive integer` is thrown.

The existing tests must keep passing.
