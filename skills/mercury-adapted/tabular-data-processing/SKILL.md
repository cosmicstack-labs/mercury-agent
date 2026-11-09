---
name: mercury-tabular-data-processing
description: Convert, join, filter and summarize CSV and TSV files with measured row counts, preserved types and verified reconciliation.
category: data
id: data/tabular-data-processing
version: 0.2.0
license: MIT
author: Cosmic Stack
intents: [convert-csv, summarize-csv, join-tables, clean-tabular-data]
tags: [csv, tsv, data, sqlite, conversion]
allowed-tools: []
---

# Tabular Data Processing

An independently authored Mercury procedure, not a bundled conversion tool. It drives
the Python standard library already present on the host through run_command. No
package is installed, no network call is made and no service sees the data. Use
read_file and list_dir for bounded inspection of small files; use run_command for
anything sizeable.

This is a rewrite of a widely available capability, not an adaptation of any
upstream CSV toolkit. No upstream script or library is vendored. Where a mature CLI
such as miller, csvkit or xsv is genuinely installed it may be preferred, but never
assume it exists.

Loading this skill grants no tool permissions. All file access and commands remain
subject to Mercury's configured permissions and approval checks.

## Measure before converting

1. Identify each input path, its apparent delimiter, its encoding and whether it has
   a header row. Do not infer these from the file extension alone.
2. Agree on input-size and time limits. Count records and columns first, and keep
   the numbers. A conversion not reconciled against input counts is unverified.
   For a confirmed comma-delimited UTF-8 input, stream records rather than loading
   the entire file into memory (this count includes a header if present):

   ```
   python3 -c "import csv,sys
   from collections import Counter
   with open(sys.argv[1],newline='',encoding='utf-8-sig') as f:
    widths=Counter(len(row) for row in csv.reader(f))
   print('records',sum(widths.values()),'widths',dict(widths))" file.csv
   ```

3. Read with `newline=''` so the CSV parser handles newline characters itself.
   Otherwise text-mode translation can change embedded line endings.
4. Detect encoding before trusting text. A UTF-8 BOM left in place turns the first
   header into `'\ufeffid'` instead of `'id'`, so every later lookup of `id` misses.
   `utf-8-sig` handles an optional UTF-8 BOM, but is not an encoding detector.
   Use it for confirmed UTF-8 input and record the encoding actually used.
5. Parse quoted fields with `csv.reader`, not `split(',')`: delimiters and newlines
   may occur inside quoted fields. Treat `csv.Sniffer` as a suggestion only and
   validate it against the file. If detection fails, confirm the delimiter or a
   genuinely single-column format rather than silently choosing one.
6. Treat the first non-empty line as a header only if it is actually one. Confirm
   whether the file is headered, and state the assumption in the report.

## Preserve types

7. Never let numeric coercion silently destroy an identifier: converting `01234`
   to an integer loses its leading zero. Read identifier columns as text; coerce
   only columns you can name as genuinely numeric, and say which.
8. Decide and record how empty values are represented: empty string, `None`, `NULL`
   or a sentinel. `csv.DictReader` represents a missing trailing field as `None`,
   which is not the same as an empty string.
9. Watch numeric precision. Read money as `decimal.Decimal` from its string form, not
   as `float`, and state the rounding rule before summarizing.
10. Record the date/time format actually observed, and whether time zones or local
    offsets are present. Do not assume ISO 8601.

## Handle dirty structure explicitly

11. Detect ragged records before converting. `csv.DictReader` can represent
    missing fields as `None` and surplus fields under a `None` key instead of
    raising an error. Reject or explicitly handle each case and count it.
12. Query `csv.field_size_limit()` rather than assuming a universal default. If a
    field exceeds it, report that failure. Raise the limit only within agreed
    memory and input-size bounds; never set an unbounded limit automatically.
13. Decide the policy for duplicates, leading/trailing whitespace, embedded newlines
    and inconsistent quoting, and apply it uniformly rather than per row.
14. Never edit the source in place. Write to a new path, and refuse to overwrite an
    existing destination without explicit approval.

## Convert and query

15. Prefer one documented path: parse with `csv`, transform in memory or stream, then
    write with `csv.writer` using `QUOTE_MINIMAL` and `lineterminator='\n'` for
    stable, diffable output. Quote anything containing the delimiter, a quote or a
    newline.
16. For joining or grouping more than a trivial amount of data, load into SQLite
    through the `sqlite3` standard-library module rather than hand-rolling the join.
    The `sqlite3` command-line binary is often absent even when the module is
    present; do not depend on the CLI. Declare column types at table creation so
    identifier text columns stay text.
17. State join semantics before running: inner or left, the exact key columns, and
    what happens to unmatched rows and duplicate keys. Report rows in, rows out and
    rows dropped on each side. A join whose row count is not reconciled is unverified.
18. For non-ASCII output, write UTF-8 explicitly and confirm the round trip decodes
    back to the same strings.

## Verify before delivery

19. Re-read the produced file with the independent parser path and compare against the
    input: record count, column count, header names, sum or distinct count of one or
    two key columns, and a sampled row. Report the before and after numbers.
20. Confirm the output opens in the intended consumer, not only in Python. State
    which consumer was exercised and which was assumed.
21. Spot checks are not certification. A file that parses is not automatically
    correct; unavailable validation is a reported limitation, not a pass.
22. Report input and output paths, encoding, delimiter, header assumption, coercion
    decisions, recorded counts, exit status and every limitation. If a check could
    not run, label the artifact unverified and name the next check.

Use `mercury-file-organization` when several files are being restructured at once.
If a downstream consumer interprets spreadsheet formulas, agree on handling of
formula-like cells and verify that consumer without silently changing source data.

Keep operational notes limited to this artifact. Durable user knowledge belongs only
in the Second Brain through its supported interface; never substitute a file. No
library, runtime script or dataset is bundled.
