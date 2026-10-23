# The CLI mishandles help, unknown options and --times values

`src/cli.js` prints a greeting. Its argument handling does not match what the
documented interface promises, and a typo changes the output instead of failing.

Required behaviour:

1. `--help` prints `usage: bench-cli [--help] [--version] [--times N] <name>` to
   stdout, writes nothing to stderr, and exits `0`.
2. `--version` prints `1.0.0` to stdout and exits `0`.
3. An option the tool does not know, such as `--nope`, writes exactly
   `unknown option: --nope` to stderr, writes nothing to stdout, and exits `2`.
4. `--times` with no following value writes exactly `--times requires a value` to
   stderr and exits `2`.
5. `--times` with a value that is not a positive integer writes exactly
   `--times must be a positive integer` to stderr and exits `2`.
6. `--times 2 Ada` prints `Hello, Ada` twice and exits `0`.
7. `Ada` alone prints `Hello, Ada` once; with no name the greeting uses `world`.
8. `--help` wins over any other argument.

The existing tests must keep passing. The command must behave the same on Node 22
and Node 24.
