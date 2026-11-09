---
name: mercury-tabular-data-processing
description: Convert, join, filter and summarize CSV and TSV files with measured row counts, preserved types and verified reconciliation.
category: data
id: data/tabular-data-processing
version: 0.1.0
license: MIT
author: Cosmic Stack
intents: [convert-csv, summarize-csv, join-tables, clean-tabular-data]
tags: [csv, tsv, data, sqlite, conversion]
allowed-tools: [read_file, list_dir, run_command, ask_user, use_skill]
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

## Measure before converting

1. Identify each input path, its apparent delimiter, its encoding and whether it has
   a header row. Do not infer these from the file extension alone.
2. Count records and columns first, and keep the numbers. A conversion that is not
   reconciled against an input count is unverified.

   ```
   python3 -c "import csv,sys
   rows=list(csv.reader(open(sys.argv[1],newline='',encoding='utf-8-sig')))
   print('records',len(rows),'widths',sorted({len(r) for r in rows}))" file.csv
   ```

3. Read with `newline=''`. Omitting it lets Python translate line endings inside
   quoted fields and silently splits multi-line records.
4. Detect encoding before trusting text. A UTF-8 BOM left in place turns the first
   header into `'\ufeffid'` instead of `'id'`, so every later lookup of `id` misses.
   Measured: `utf-8` produced the key `'\ufeffid'`; `utf-8-sig` produced `'id'`.
   Default to `utf-8-sig` for input, and record the encoding actually used.
5. Do not guess a delimiter with a naive `split(',')`. Measured on a file whose
   field contains `said "hi", then left`, naive comma splitting produced 5 tokens
   where `csv.reader` correctly produced 3 fields and 4 records overall. Use
   `csv.Sniffer` as a suggestion only, then verify: it correctly found `;` and `\t`
   on semicolon and tab files, but on a single-column file it raises
   `Could not determine delimiter`. Have an explicit fallback to a single column.
6. Treat the first non-empty line as a header only if it is actually one. Confirm
   whether the file is headered, and state the assumption in the report.

## Preserve types

7. Never let a numeric coercion silently destroy an identifier. Measured: ZIP codes
   `01234`, `00501` and codes `007`, `010` became `1234`, `501`, `7`, `10` when cast
   to integers. Read identifier columns as text; coerce only columns you can name as
   genuinely numeric, and say which.
8. Decide and record how empty values are represented: empty string, `None`, `NULL`
   or a sentinel. `csv.DictReader` represents a missing trailing field as `None`,
   which is not the same as an empty string.
9. Watch numeric precision. Read money as `decimal.Decimal` from its string form, not
   as `float`, and state the rounding rule before summarizing.
10. Record the date/time format actually observed, and whether time zones or local
    offsets are present. Do not assume ISO 8601.

## Handle dirty structure explicitly

11. Detect ragged records before converting. Measured on a four-record file with
    widths `[3, 3, 2, 4]`, `csv.DictReader` silently produced a `None` value for
    the short record and a bogus `None: ['9']` key for the long one. Neither is an
    error, so a naive pass reports success while corrupting data.
12. For every over-long field, raise the parser limit deliberately.
    `csv.field_size_limit()` defaults to 131072 characters; a long text column
    raises `_csv.Error: field larger than field limit` without explanation.
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

Pair this with `mercury-verification-before-completion` when the output feeds a
further stage, and with `mercury-file-organization` when several files are being
restructured at once.

Keep operational notes limited to this artifact. Durable user knowledge belongs only
in the Second Brain through its supported interface; never substitute a file. No
library, runtime script or dataset is bundled.
