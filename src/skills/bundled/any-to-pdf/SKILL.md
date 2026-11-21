---
name: any-to-pdf
description: Turn Markdown, text, Word, HTML, CSV, code or images into a professionally typeset PDF — cover page, table of contents, themes, tables, code blocks, CJK text and emoji — with the bundled converter. Use it when the owner wants a polished PDF rather than a plain export.
version: 1.0.0
category: productivity
tags:
  - pdf
  - any2pdf
  - markdown to pdf
  - report
  - typeset
---

# Any to PDF

Use this when the owner wants a good-looking PDF: a report, a write-up, notes, a data table or a set of images. For other formats (Word, slides, spreadsheets) use the `documents` skill.

## Run it

The converter is in this skill's `scripts/` folder (the folder path is shown with these instructions). Run it with Python 3.8 or newer — `python3` on macOS, Linux and Termux, `python` or `py` on Windows:

```bash
python3 "<skill folder>/scripts/any2pdf.py" report.md -o report.pdf
```

- **Inputs:** Markdown and text; Word (`.docx`); HTML; CSV/TSV (become tables); code, JSON, YAML and logs (become code blocks); images (one page each). With pandoc installed, also ODT, RTF, EPUB, reStructuredText, LaTeX and notebooks. Several inputs make one PDF, in the order given.
- **Output:** `-o` names the PDF; without it, the PDF sits next to the first input. It never overwrites an input.
- **First run:** it installs what it needs into Mercury's cache (`~/.mercury/cache/any2pdf`), never into the system Python. reportlab first (about 20 MB). A Word file adds mammoth, HTML adds markdownify (each under 1 MB). Display formulas (`$$ … $$`) add matplotlib (about 100 MB) for typeset maths; if that can't be installed, formulas still appear as styled text. Tell the owner when a first run is installing something.

## Options

Pass them after the inputs:

| Option | What it does |
|---|---|
| `--theme NAME` | Look and colours (below). Default `warm-academic`. |
| `--title`, `--subtitle`, `--author`, `--date`, `--version` | Cover page text (title defaults to the first heading). |
| `--cover false`, `--toc false` | Leave out the cover page or the table of contents. Short documents read better without both. |
| `--watermark "DRAFT"` | Diagonal watermark on every page. |
| `--page-size Letter` | US Letter instead of A4. |
| `--header-title`, `--footer-left` | Running header and footer text. |
| `--frontispiece IMG`, `--banner IMG` | Full-page image after the cover; back-cover image. |
| `--disclaimer`, `--copyright` | Back-cover text. |

Themes: `warm-academic` (ivory and terracotta), `github-light` (clean white and blue), `nord-frost`, `solarized-light`, `paper-classic`, `ocean-breeze`, `tufte` (minimal), `classic-thesis`, `ieee-journal`, `elegant-book`, `chinese-red`, `ink-wash` (greyscale), `monokai-warm`, `dracula-soft`. `references/themes.md` describes them.

## Workflow

1. **Get the content into one file.** If you're writing the document, write Markdown first (headings, lists, tables, fenced code).
2. **Pick the options yourself.** Use what the owner asked for; otherwise choose a theme that fits the content (`github-light` for technical documents, `warm-academic` or `elegant-book` for reports, `tufte` for prose) and leave out the cover and contents for anything under about three pages. Only ask the owner about styling when they said they care about it — and never in an unattended run.
3. **Run the converter** and read its last line: `PDF: <path> (<size>)`.
4. **Check it.** The file exists and isn't tiny. If a page might be wrong (CJK, tables, images), look at it before saying it's done.
5. **Deliver it.** Say where it is; on chat channels send it with `send_file`.

## When it fails

- **No Python:** say so and fall back to the `documents` skill (pandoc, or HTML printed to PDF).
- **pip can't install:** the error names the fix (usually install pip for that Python). Offline machines can't do a first run.
- **Missing fonts on Linux** (boxes instead of characters): `fonts-noto-cjk` and `fonts-noto-color-emoji` fix it; the PDF is still produced.

The converter (`scripts/md2pdf.py`) is lovstudio/any2pdf, MIT License — see `scripts/LICENSE-md2pdf.txt`.
