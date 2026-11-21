#!/usr/bin/env python3
"""
Any to PDF: turn a document, data file, code file or images into a typeset PDF.

    python3 any2pdf.py INPUT [INPUT ...] [-o OUT.pdf] [md2pdf options]

Markdown and text go straight to md2pdf.py (reportlab). Other inputs are
converted to Markdown first: CSV/TSV become tables, code and JSON/YAML become
code blocks, Word/HTML go through pandoc when it's installed (else mammoth /
markdownify), and images become one page each.

Nothing heavy is installed until it's needed. The first run installs reportlab
(about 4 MB) into Mercury's cache, not into the system Python; matplotlib
(formulas), mammoth (Word) and markdownify (HTML) are added only when a
document needs them. Part of Mercury's built-in skills.
"""
from __future__ import annotations

import csv, os, shutil, subprocess, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
MD2PDF = HERE / "md2pdf.py"

# Pinned to major versions the converter was tested with.
PACKAGES = {
    "reportlab": "reportlab>=4,<5",
    "matplotlib": "matplotlib>=3.5,<4",
    "mammoth": "mammoth>=1.6,<2",
    "markdownify": "markdownify>=0.11,<2",
}
SIZES = {"reportlab": "about 20 MB with Pillow", "matplotlib": "about 100 MB with numpy", "mammoth": "under 1 MB", "markdownify": "under 1 MB"}

TEXT = {".md", ".markdown", ".mdown", ".txt", ".text"}
IMAGES = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".tiff", ".webp"}
TABLES = {".csv": ",", ".tsv": "\t"}
PANDOC_ONLY = {".odt", ".rtf", ".epub", ".rst", ".org", ".tex", ".latex", ".textile", ".mediawiki", ".ipynb"}
CODE = {
    ".py": "python", ".js": "javascript", ".mjs": "javascript", ".ts": "typescript", ".tsx": "tsx", ".jsx": "jsx",
    ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml", ".xml": "xml", ".sh": "bash", ".zsh": "bash",
    ".ps1": "powershell", ".rb": "ruby", ".go": "go", ".rs": "rust", ".java": "java", ".kt": "kotlin", ".swift": "swift",
    ".c": "c", ".h": "c", ".cpp": "cpp", ".cs": "csharp", ".php": "php", ".sql": "sql", ".css": "css", ".log": "text",
    ".ini": "ini", ".cfg": "ini", ".env.example": "bash",
}


def mercury_home() -> Path:
    return Path(os.environ.get("MERCURY_HOME") or Path.home() / ".mercury")


def site_dir() -> Path:
    """Per-Python-version package folder in Mercury's cache (never the system Python)."""
    v = f"py{sys.version_info.major}{sys.version_info.minor}"
    return mercury_home() / "cache" / "any2pdf" / v


def ensure(*names: str, optional: bool = False) -> bool:
    """Install the named packages into the cache on first use. An optional
    package that can't be installed is skipped (returns False) instead of failing."""
    target = site_dir()
    if str(target) not in sys.path:
        sys.path.insert(0, str(target))
    missing = []
    for name in names:
        try:
            __import__(name)
        except ImportError:
            missing.append(name)
    if not missing:
        return True
    target.mkdir(parents=True, exist_ok=True)
    what = ", ".join(f"{n} ({SIZES[n]})" for n in missing)
    print(f"First use: installing {what} into {target} …", file=sys.stderr, flush=True)
    cmd = [sys.executable, "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "--target", str(target)]
    cmd += [PACKAGES[n] for n in missing]
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if result.returncode != 0:
        tail = "\n".join(result.stdout.strip().splitlines()[-8:])
        if optional:
            print(f"Couldn't install {', '.join(missing)}; continuing without it.\n{tail}", file=sys.stderr)
            return False
        sys.exit(
            f"Couldn't install {', '.join(missing)} with pip:\n{tail}\n\n"
            "Fix: make sure pip works for this Python (`python3 -m ensurepip --user`, or install python3-pip),"
            " then run again."
        )
    import importlib
    importlib.invalidate_caches()
    for name in missing:
        __import__(name)
    return True


def code_block(text: str, lang: str) -> str:
    fence = "````" if "```" in text else "```"
    return f"{fence}{lang}\n{text.rstrip()}\n{fence}\n"


def table_md(path: Path, delimiter: str) -> str:
    with open(path, newline="", encoding="utf-8-sig", errors="replace") as f:
        rows = list(csv.reader(f, delimiter=delimiter))
    rows = [r for r in rows if any(c.strip() for c in r)]
    if not rows:
        return "_(empty table)_\n"
    width = max(len(r) for r in rows)
    clean = lambda c: c.replace("|", "\\|").replace("\n", " ").strip()
    rows = [[clean(c) for c in r] + [""] * (width - len(r)) for r in rows]
    out = ["| " + " | ".join(rows[0]) + " |", "|" + "---|" * width]
    out += ["| " + " | ".join(r) + " |" for r in rows[1:]]
    return "\n".join(out) + "\n"


def pandoc_md(path: Path) -> str | None:
    if not shutil.which("pandoc"):
        return None
    r = subprocess.run(["pandoc", str(path), "-t", "gfm", "--wrap=none"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if r.returncode != 0:
        sys.exit(f"pandoc couldn't read {path.name}: {r.stderr.strip()[:400]}")
    return r.stdout


def to_markdown(path: Path) -> str:
    ext = "".join(path.suffixes[-2:]).lower() if path.name.lower().endswith(".env.example") else path.suffix.lower()
    if ext in TEXT:
        return path.read_text(encoding="utf-8", errors="replace")
    if ext in TABLES:
        return f"# {path.stem}\n\n" + table_md(path, TABLES[ext])
    if ext in CODE:
        return f"# {path.name}\n\n" + code_block(path.read_text(encoding="utf-8", errors="replace"), CODE[ext])
    if ext == ".docx":
        md = pandoc_md(path)
        if md is not None:
            return md
        ensure("mammoth")
        import mammoth
        with open(path, "rb") as f:
            return mammoth.convert_to_markdown(f).value
    if ext in {".html", ".htm", ".xhtml"}:
        md = pandoc_md(path)
        if md is not None:
            return md
        ensure("markdownify")
        from markdownify import markdownify
        return markdownify(path.read_text(encoding="utf-8", errors="replace"), heading_style="ATX")
    if ext in PANDOC_ONLY:
        md = pandoc_md(path)
        if md is None:
            sys.exit(f"{ext} files need pandoc, which isn't installed. Install it (https://pandoc.org/installing.html) and run again.")
        return md
    if ext == ".pdf":
        sys.exit(f"{path.name} is already a PDF.")
    sys.exit(f"Don't know how to turn {ext or 'a file without an extension'} into a PDF. Supported: Markdown, text, Word, HTML,"
             " CSV/TSV, code and data files, images, and (with pandoc) ODT, RTF, EPUB, reStructuredText, LaTeX, notebooks.")


def images_pdf(paths: list[Path], out: Path, page: str) -> None:
    """One page per image, scaled to fit with a margin."""
    ensure("reportlab")
    from reportlab.lib.pagesizes import A4, LETTER
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas
    size = LETTER if page == "Letter" else A4
    margin = 36
    c = canvas.Canvas(str(out), pagesize=size)
    for p in paths:
        try:
            img = ImageReader(str(p))
        except Exception as e:  # unreadable or unsupported (webp needs Pillow with webp)
            sys.exit(f"Couldn't read image {p.name}: {e}")
        iw, ih = img.getSize()
        w, h = size[0] - 2 * margin, size[1] - 2 * margin
        scale = min(w / iw, h / ih, 1.0)  # fit the page; never blow a small image up
        dw, dh = iw * scale, ih * scale
        c.drawImage(img, (size[0] - dw) / 2, (size[1] - dh) / 2, dw, dh, preserveAspectRatio=True, mask="auto")
        c.showPage()
    c.save()


def needs_formulas(md: str) -> bool:
    """Display math ($$ … $$ or \\[ … \\]) on a line of its own, outside code blocks."""
    fenced = False
    for line in md.splitlines():
        stripped = line.strip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            fenced = not fenced
            continue
        if not fenced and (stripped.startswith("$$") or stripped.startswith("\\[")):
            return True
    return False


def main() -> None:
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__.strip())
        print("\nmd2pdf options (themes, cover, TOC, watermark …):")
        print("  --theme NAME  --title T  --subtitle S  --author A  --watermark W  --cover false  --toc false  --page-size Letter")
        return
    inputs: list[Path] = []
    rest: list[str] = []
    out: Path | None = None
    i = 0
    while i < len(args):
        a = args[i]
        if a in ("-o", "--output") and i + 1 < len(args):
            out = Path(args[i + 1]).expanduser().resolve(); i += 2; continue
        if a.startswith("-"):
            rest.append(a)
            if i + 1 < len(args) and not args[i + 1].startswith("-") and a not in ("--input", "-i"):
                rest.append(args[i + 1]); i += 1
            i += 1; continue
        inputs.append(Path(a).expanduser().resolve()); i += 1
    if not inputs:
        sys.exit("Give at least one input file.")
    for p in inputs:
        if not p.is_file():
            sys.exit(f"Not found: {p}")
    if out is None:
        out = inputs[0].with_suffix(".pdf")
    if out.resolve() in {p.resolve() for p in inputs}:
        sys.exit("The output would overwrite an input; pass -o with a new name.")
    out.parent.mkdir(parents=True, exist_ok=True)
    page = "Letter" if "Letter" in rest else "A4"

    if all(p.suffix.lower() in IMAGES for p in inputs):
        images_pdf(inputs, out, page)
    else:
        parts = []
        for p in inputs:
            if p.suffix.lower() in IMAGES:
                parts.append(f"![{p.stem}]({p.resolve().as_uri()})\n")
            else:
                parts.append(to_markdown(p))
        md = "\n\n".join(parts)
        ensure("reportlab")
        # Formulas render as styled text without matplotlib; with it, as typeset images.
        if needs_formulas(md):
            ensure("matplotlib", optional=True)
        with tempfile.TemporaryDirectory(prefix="any2pdf-") as tmp:
            src = Path(tmp) / (inputs[0].stem + ".md")
            src.write_text(md, encoding="utf-8")
            env = dict(os.environ)
            env["PYTHONPATH"] = os.pathsep.join([str(site_dir()), env.get("PYTHONPATH", "")]).rstrip(os.pathsep)
            r = subprocess.run([sys.executable, str(MD2PDF), "--input", str(src), "--output", str(out), *rest], env=env, cwd=str(inputs[0].parent))
            if r.returncode != 0:
                sys.exit(r.returncode)
    if not out.is_file() or out.stat().st_size == 0:
        sys.exit("No PDF was written.")
    print(f"PDF: {out} ({out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
