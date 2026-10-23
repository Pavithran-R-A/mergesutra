# runWithTimeout leaves a timer behind after a fast settlement

`runWithTimeout(operation, ms)` races an async operation against a deadline. It
works for the simple cases its tests cover, but a caller that awaits it keeps the
process alive until the deadline expires, and bad arguments fail in confusing ways.

Required behaviour:

1. When the operation settles within `ms`, the returned promise settles with the
   same value or error.
2. When the operation is still pending at `ms`, the promise rejects with an
   `Error` whose message is exactly `timed out after <ms> ms`.
3. The deadline timer is cleared on every settlement path. A process that awaits a
   fast settlement must be able to exit immediately, not after `ms`.
4. `operation` must be a function, otherwise a `TypeError` with the message exactly
   `operation must be a function` is thrown synchronously.
5. `ms` must be a positive finite number, otherwise a `RangeError` with the message
   exactly `ms must be a positive number` is thrown synchronously.

The existing tests must keep passing.
