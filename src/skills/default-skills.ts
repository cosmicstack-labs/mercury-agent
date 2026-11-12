export interface DefaultSkillSeed {
  dirName: string;
  fileName: string;
  content: string;
}

/** Category labels shown to the user in grouped skill output */
export const CATEGORY_LABELS: Record<string, string> = {
  web: 'Web & Research',
  social: 'Social Media',
  media: 'Media & Downloads',
  productivity: 'Productivity',
  system: 'System Administration',
  development: 'Development',
  uncategorized: 'Other',
};

export function getCategoryLabel(category: string): string {
  return CATEGORY_LABELS[category] || category.charAt(0).toUpperCase() + category.slice(1);
}

/**
 * Earlier contents of built-in skills. A user's copy that still matches one
 * exactly was never edited, so it is upgraded to the current seed.
 */
export const PREVIOUS_SEED_CONTENTS: Record<string, string[]> = {
  'web-search': [`---
name: web-search
description: Search the web and the news with the web_search tool, read the best sources, and answer with links.
version: 1.2.0
category: web
categories:
  - web
  - research
intents:
  - search the web
  - look up
  - find online
  - what is
  - current news
  - search for
  - find information about
  - research
  - web search
  - latest news
  - what's happening
tags:
  - search
  - web
  - research
  - news
allowed-tools:
  - web_search
  - fetch_url
---

# Web Search

Use this skill when the user asks for current events, external facts, or web research.

## Workflow

1. Call web_search with a focused query of a few key words (names, product, place, year).
   For news and recent events use kind "news" (an empty query gives today's top stories).
2. Open the most relevant one to three results with fetch_url when the snippets aren't enough.
3. Nothing useful? Rephrase once (synonyms, the official name, fewer words) and search again
   before saying you could not find it.
4. Cross-check key facts across at least 2 sources when possible.
5. Return a concise answer with source links and clear caveats.

## Rules

- Prefer reliable sources (official docs, primary sources, reputable publications).
- If information is uncertain or conflicting, say so explicitly.
- Include source URLs in the response (on phone chats, keep it to the one or two that matter).
- Avoid fabricated citations.
- Never fetch a search engine's results page (DuckDuckGo, Google, Bing) with fetch_url: they block
  automated reads. web_search already tries several free engines (Brave, Wikipedia, Hacker News,
  news feeds) and keeps only results that match the query.
`, `---
name: web-search
description: Search the web and the news with the web_search tool, read the best sources, and answer with links.
version: 1.1.0
category: web
categories:
  - web
  - research
intents:
  - search the web
  - look up
  - find online
  - what is
  - current news
  - search for
  - find information about
  - research
  - web search
  - latest news
  - what's happening
tags:
  - search
  - web
  - research
  - news
allowed-tools:
  - web_search
  - fetch_url
---

# Web Search

Use this skill when the user asks for current events, external facts, or web research.

## Workflow

1. Call web_search with a focused query. For news and recent events use kind "news"
   (an empty query gives today's top stories).
2. Open the most relevant one to three results with fetch_url when the snippets aren't enough.
3. Cross-check key facts across at least 2 sources when possible.
4. Return a concise answer with source links and clear caveats.

## Rules

- Prefer reliable sources (official docs, primary sources, reputable publications).
- If information is uncertain or conflicting, say so explicitly.
- Include source URLs in the response (on phone chats, keep it to the one or two that matter).
- Avoid fabricated citations.
`, `---
name: web-search
description: Perform web searches using DuckDuckGo HTML and summarize sources.
version: 1.0.0
category: web
categories:
  - web
  - research
intents:
  - search the web
  - look up
  - find online
  - what is
  - current news
  - search for
  - find information about
  - research
  - web search
tags:
  - search
  - web
  - research
  - duckduckgo
allowed-tools:
  - fetch_url
---

# Web Search

Use this skill when the user asks for current events, external facts, or web research.

## Workflow

1. Build a DuckDuckGo HTML search URL:
   - https://html.duckduckgo.com/html/?q=<query>
2. Use fetch_url with markdown format to retrieve result page content.
3. Extract likely source links and open the top relevant pages with fetch_url.
4. Cross-check key facts across at least 2 sources when possible.
5. Return a concise answer with source links and clear caveats.

## Rules

- Prefer reliable sources (official docs, primary sources, reputable publications).
- If information is uncertain or conflicting, say so explicitly.
- Include source URLs in the response.
- Avoid fabricated citations.
`],
};

export const DEFAULT_SKILL_SEEDS: DefaultSkillSeed[] = [
  {
    dirName: 'web-search',
    fileName: 'SKILL.md',
    content: `---
name: web-search
description: Search the web and the news with the web_search tool, read the best sources, and answer with links.
version: 1.3.0
category: web
categories:
  - web
  - research
intents:
  - search the web
  - look up
  - find online
  - what is
  - current news
  - search for
  - find information about
  - research
  - web search
  - latest news
  - what's happening
tags:
  - search
  - web
  - research
  - news
allowed-tools:
  - web_search
  - fetch_url
---

# Web Search

Use this skill when the user asks for current events, external facts, or web research.

## Workflow

1. Call web_search with a focused query of a few key words (names, product, place, year).
   For news and recent events use kind "news" (an empty query gives today's top stories).
2. Open the most relevant one to three results with fetch_url when the snippets aren't enough.
3. Nothing useful? Rephrase once (synonyms, the official name, fewer words) and search again
   before saying you could not find it.
4. Cross-check key facts across at least 2 sources when possible.
5. Return a concise answer with source links and clear caveats.

## Rules

- Prefer reliable sources (official docs, primary sources, reputable publications).
- If information is uncertain or conflicting, say so explicitly.
- Include source URLs in the response (on phone chats, keep it to the one or two that matter).
- Avoid fabricated citations.
- Never fetch a search engine's results page (DuckDuckGo, Google, Bing) with fetch_url: they block
  automated reads. web_search already does it properly.

## Where results come from

web_search needs no key and works with any model. For web searches it asks, in order:

1. Parallel search (search.parallel.ai), a search index built for agents, with excerpts and dates.
2. DuckDuckGo's html page.
3. DuckDuckGo's lite page.

News searches ask Parallel (article links only), then Bing News, Google News and Hacker News.
Only results that mention the query are kept, and sources are combined until there are enough.

Every result ends with a "Searched:" trail, for example
"Parallel: timed out → DuckDuckGo: 8 results". If web_search returns an error, every source failed:
tell the user which ones and why (blocked, timed out, no results) instead of guessing an answer,
then try one shorter or rephrased query.
`,
  },
  {
    dirName: 'computer-health',
    fileName: 'SKILL.md',
    content: `---
name: computer-health
description: Check what's wrong with this computer or a service on it — disk space, memory, CPU, processes, open ports, Docker containers and their logs, battery — with read-only commands, then explain what was found before suggesting any fix.
version: 1.0.0
category: system
tags:
  - diagnostics
  - disk
  - memory
  - processes
  - docker
  - ports
---

# Computer health

Use this when the owner asks why the computer is slow, full, hot or noisy, what is running, what uses a port, or why a container or service is down.

## Rules

- Look first, change nothing. Every command in "Checks" only reads. Anything that stops, deletes, restarts or installs is a separate step the owner agrees to.
- Find the platform once (\`uname -s\`; on Windows the shell is PowerShell; on Android/Termux \`$PREFIX\` contains \`com.termux\`) and use the matching commands below.
- Keep output small: sort, then \`head\` (PowerShell: \`Select-Object -First 15\`). Never dump a whole process list or log.
- Report in plain words with the numbers that matter ("the disk is 94% full; 41 GB of it is ~/Library/Caches"), then the likely cause, then one or two fixes to choose from.

## Checks

| What | macOS | Linux / Termux | Windows (PowerShell) |
|---|---|---|---|
| Disk free | \`df -h /\` | \`df -h /\` (Termux: \`df -h $HOME\`) | \`Get-PSDrive -PSProvider FileSystem\` |
| Biggest folders | \`du -sh ~/* 2>/dev/null \\| sort -rh \\| head -15\` | same | \`Get-ChildItem $HOME -Directory \\| ForEach-Object { [pscustomobject]@{Name=$_.Name; GB=[math]::Round((Get-ChildItem $_.FullName -Recurse -File -ErrorAction SilentlyContinue \\| Measure-Object Length -Sum).Sum/1GB,2)} } \\| Sort-Object GB -Descending \\| Select-Object -First 15\` |
| Memory | \`vm_stat\`, \`memory_pressure\` | \`free -h\` | \`Get-CimInstance Win32_OperatingSystem \\| Select-Object FreePhysicalMemory,TotalVisibleMemorySize\` |
| Top CPU / memory | \`ps -Ao pid,pcpu,pmem,comm -r \\| head -15\` | \`ps -eo pid,pcpu,pmem,comm --sort=-pcpu \\| head -15\` | \`Get-Process \\| Sort-Object CPU -Descending \\| Select-Object -First 15 Id,CPU,WS,ProcessName\` |
| Who uses a port | \`lsof -nP -iTCP:PORT -sTCP:LISTEN\` | \`ss -ltnp \\| grep :PORT\` | \`Get-NetTCPConnection -LocalPort PORT -State Listen\` |
| Uptime / load | \`uptime\` | \`uptime\` | \`(Get-CimInstance Win32_OperatingSystem).LastBootUpTime\` |
| Battery | \`pmset -g batt\` | \`upower -i $(upower -e \\| grep BAT)\` (Termux: \`termux-battery-status\`) | \`Get-CimInstance Win32_Battery\` |

## Docker and services

1. \`docker ps -a --format '{{.Names}}\\t{{.Status}}\\t{{.Image}}'\` — what runs, what exited, what is unhealthy.
2. For one container: \`docker logs --tail 80 NAME\` and, when it reports a health status, \`docker inspect --format '{{json .State.Health}}' NAME\`.
3. Resource use: \`docker stats --no-stream\`.
4. Services (Linux): \`systemctl --failed\` and \`journalctl -u NAME -n 80 --no-pager\`. macOS: \`launchctl list | grep -i NAME\`.

Explain the error from the logs in one or two sentences and quote the decisive line. Restarting or rebuilding is the owner's call.
`,
  },
  {
    dirName: 'tidy-files',
    fileName: 'SKILL.md',
    content: `---
name: tidy-files
description: Organize, clean up or bulk-rename files and folders (Downloads, Desktop, photos, duplicates) safely — show the plan first, move instead of delete, and report exactly what changed.
version: 1.0.0
category: productivity
tags:
  - files
  - cleanup
  - organize
  - rename
  - duplicates
---

# Tidy files

Use this when the owner asks to clean up, sort, deduplicate or rename many files.

## Workflow

1. **Look.** \`list_dir\` the folder, then measure with \`run_command\`: how many files, how much space, which types (\`find DIR -type f | sed 's/.*\\.//' | sort | uniq -c | sort -rn | head\`). On Windows use PowerShell \`Get-ChildItem -Recurse -File | Group-Object Extension\`.
2. **Plan.** Propose the rule in one or two sentences ("images into Pictures/2026, installers older than 30 days into _to-delete") and show a sample of what moves where with the total count.
3. **Ask.** Get a clear yes (ask_user) before touching anything. A change of plan means a new plan and a new yes.
4. **Move, don't delete.** Do it with one script or command for all files, not one call per file. Anything to remove goes into a dated folder such as \`_to-delete-2026-11-10\` inside the same folder, never straight to deletion. Never overwrite: add a suffix when a name already exists.
5. **Report.** How many files moved, where to, how much space the \`_to-delete\` folder holds, and how to undo it (move the folder back). Deleting \`_to-delete\` for real is a separate yes.

## Duplicates

Find them by content, not by name: group same-size files first, then hash only those (\`shasum -a 256\`, Linux \`sha256sum\`, PowerShell \`Get-FileHash\`). Keep the oldest copy, or the one in the better-named folder, and list the rest for \`_to-delete\`.

## Never

- Touch system folders, app bundles, \`.git\` folders, or anything outside the folder the owner named.
- Rename files a program depends on (projects, photo libraries, music libraries) without saying so first.
`,
  },
  {
    dirName: 'data-analysis',
    fileName: 'SKILL.md',
    content: `---
name: data-analysis
description: Analyse CSV, Excel or JSON data — look at the columns first, compute every number with a script instead of by eye, check the result, then summarize and chart it.
version: 1.0.0
category: productivity
tags:
  - data
  - csv
  - excel
  - spreadsheet
  - chart
  - statistics
---

# Data analysis

Use this when the owner shares a spreadsheet, CSV or JSON file, or asks for totals, trends, comparisons or a chart from data.

## Workflow

1. **Inspect before computing.** Row count, column names and types, a few sample rows, empty values. For a small file \`read_file\` is enough; for a large one use \`run_command\` (\`head -5 file.csv\`, \`wc -l file.csv\`) or a short script.
2. **Compute with code, never by reading numbers.** Write one short script (Python with pandas or the csv module; \`python3 -c "import pandas"\` tells you which is available) and run it with \`run_command\`. Print only the results, not whole tables.
3. **Check.** Totals add up, row counts match, no column was parsed as text by mistake (currency signs, thousands separators, dates). Say what you cleaned and how.
4. **Answer the question first**, with the key numbers, then the detail. State the time range and any rows you excluded.
5. **Chart when it helps.** Save a PNG next to the data (matplotlib), name it after what it shows, and send it with \`send_file\` on chat channels. Label axes and units.

## Rules

- Never invent or round numbers you didn't compute.
- Leave the original file unchanged; write results to a new file (\`name-summary.csv\`).
- Excel: read with pandas (\`openpyxl\` engine). Say which sheet you used if there are several.
- Money and percentages: keep the source's currency and say how you rounded.
`,
  },
  {
    dirName: 'long-documents',
    fileName: 'SKILL.md',
    content: `---
name: long-documents
description: Read and answer questions about long PDFs, logs, transcripts, books or code files — read them in sections, take notes as you go, and answer with page or line references instead of guessing from the first part.
version: 1.0.0
category: productivity
tags:
  - pdf
  - documents
  - logs
  - summarize
  - transcript
---

# Long documents

read_file returns at most 64 KB. Use this skill whenever a file is bigger than that, or the owner wants a summary, a specific detail or a comparison from a long file.

## Workflow

1. **Size it up.** \`wc -l FILE\` and \`ls -lh FILE\`. A PDF: \`pdfinfo FILE\` for pages, then \`pdftotext -layout FILE out.txt\` (if pdftotext is missing, use Python \`pypdf\`). Word files: \`pandoc FILE -t plain -o out.txt\`.
2. **Find before you read.** For a specific question, search first: \`grep -n -i "term" FILE | head -30\`, then read just around the hits (\`sed -n '120,180p' FILE\`).
3. **For a summary, read in sections** of about 300–500 lines (\`sed -n 'START,ENDp'\`), and keep short notes per section: what it covers and anything the owner is likely to ask about. Use the document's own headings or pages as section boundaries when it has them.
4. **Answer from the notes**, citing where each point is (page, section heading or line numbers). Say if you only read part of the document and which part.

## Logs

Start from the end (\`tail -200\`) and from errors (\`grep -n -iE "error|fail|exception|fatal" FILE | tail -40\`). Report the first error of a failure, not only the last one, with its timestamp.

## Rules

- Never claim the document says something you didn't read.
- Quote exactly when the wording matters (contracts, specs, error messages).
`,
  },
  {
    dirName: 'documents',
    fileName: 'SKILL.md',
    content: `---
name: documents
description: Create or convert real files — Word, PDF, slides, spreadsheets, Markdown, HTML — with pandoc or a short script, check the result opens, and send it back.
version: 1.0.0
category: productivity
tags:
  - documents
  - pdf
  - docx
  - convert
  - pandoc
  - slides
---

# Documents

Use this when the owner wants a file they can open or share (a report, letter, CV, slide deck, spreadsheet), or a file converted from one format to another.

## Workflow

1. **Agree on the content first** when it is new writing: a short outline, then the full text in Markdown.
2. **Pick the tool.** Check what is installed (\`command -v pandoc\`, \`python3 -c "import docx"\`):
   - Markdown → Word / HTML / EPUB: \`pandoc in.md -o out.docx\`.
   - Markdown → PDF: \`pandoc in.md -o out.pdf\` (needs a PDF engine; if none, make HTML and print it to PDF with the browser, or use Python \`reportlab\`).
   - Slides: \`pandoc in.md -o out.pptx\` (headings become slides; put each slide under its own heading).
   - Spreadsheets: Python \`openpyxl\` or pandas \`to_excel\`.
   - Anything → Markdown or text: \`pandoc FILE -t gfm\`; PDFs with \`pdftotext\`.
   If the tool is missing, say which one and offer to install it, or use the next option.
3. **One command for many files.** Converting a folder is one loop or one script, not one call per file.
4. **Check the result.** The file exists, has a sensible size, and opens: convert it back to text and look at the start (\`pandoc out.docx -t plain | head -20\`, \`pdftotext out.pdf - | head -20\`).
5. **Deliver.** Save it where the owner asked, otherwise in the working directory, with a clear name. On chat channels send it with \`send_file\`. Say where it is.

## Rules

- Never overwrite the source file; write to a new name.
- Keep the owner's wording in conversions; don't "improve" text you were asked to convert.
- Fonts, logos and page size follow what the owner asked; otherwise use the tool's defaults.
`,
  },
];

/**
 * Skills Mercury used to install on every start and no longer ships
 * (ADR-040): `tweet-notifier` (one owner's workflow, wrong for everyone else)
 * and `screenshot` (assumed a global Playwright install, and its
 * allowed-tools elevated run_command and file writes to prompt-free for the
 * turn). By SHA-256 of every version ever seeded: a copy that matches was
 * never edited and is moved aside; an edited copy is the owner's and stays.
 */
export const RETIRED_SEEDS: Record<string, string[]> = {
  'tweet-notifier': [
    '0b777896e3b28d6568d35b01e1ea92de6ae3c4b51098fb9f3192d74b138f3b89',
    '39624176a81dcedc554b548aa04b43e82a48c0952ee46b529554c7e155f5ba07',
  ],
  screenshot: [
    'fcc32bf6b26b05353c7c9779a21980ba9968d7f95730827e0345aefb1a555c8b',
  ],
};
