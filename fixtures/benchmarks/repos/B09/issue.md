# median sorts numbers as text and accepts non-numeric input

`median(values)` passes its current tests, which use only single-digit numbers. It
sorts with the default comparator, so `10` lands before `2`, and it coerces
whatever it is handed.

Required behaviour:

1. An odd-length numeric array returns the numeric middle value.
2. An even-length numeric array returns the mean of the two numeric middle values;
   for example `[1, 2, 3, 100]` is `2.5`.
3. The input array is not mutated.
4. A non-array throws a `TypeError` whose message is exactly `values must be an array`.
5. An empty array throws a `RangeError` whose message is exactly
   `values must not be empty`.
6. An entry that is not a finite number (a string, `NaN`, `Infinity`) throws a
   `TypeError` whose message is exactly `values must contain only finite numbers`.

The existing tests must keep passing, and the change must add at least one
regression test that fails against the current implementation.
