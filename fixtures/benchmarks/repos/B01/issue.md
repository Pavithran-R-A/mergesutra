# normalizeLabel mishandles runs of whitespace and separators

`normalizeLabel` is used to build URL fragments. It currently trims and
lowercases, but everything else passes through unchanged.

Required behaviour:

1. Leading and trailing whitespace of any ASCII kind is removed.
2. Any run of ASCII whitespace (space, tab, newline, carriage return, form feed,
   vertical tab) becomes one space.
3. ASCII letters are lowercased.
4. Any run of hyphens or underscores becomes one hyphen.
5. Any other character is left alone.
6. A non-string argument throws a `TypeError` whose message is exactly
   `label must be a string`.

The existing tests must keep passing.
