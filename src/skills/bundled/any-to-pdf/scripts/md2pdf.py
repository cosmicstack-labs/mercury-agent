#!/usr/bin/env python3
"""
md2pdf — Convert Markdown to professionally typeset PDF.

Features:
  - CJK/Latin mixed text with automatic font switching
  - Fenced code blocks with preserved indentation and line breaks
  - Markdown tables with smart proportional column widths
  - Markdown images, Obsidian callouts, emoji fallback, LaTeX-style formulas
  - Cover page, clickable TOC, PDF bookmarks, page numbers
  - Frontispiece (full-page image after cover) and back cover (banner branding)
  - Configurable color themes
  - Watermark support
  - Running header with report title + chapter name
  - Footer with author/brand, page number, date

Usage:
  python md2pdf.py --input report.md --output report.pdf --title "My Report"

Dependencies:
  pip install reportlab --break-system-packages
  Optional for rendered formulas: pip install matplotlib --break-system-packages
"""

import re, os, sys, json, argparse, io, tempfile, hashlib, urllib.parse, urllib.request
from bisect import bisect_right as _bisect_right
from datetime import date
from reportlab.lib.pagesizes import A4, LETTER
from reportlab.lib.units import mm
from reportlab.lib.colors import Color, HexColor, black, white
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY
from reportlab.lib.utils import ImageReader
from reportlab.platypus import (
    BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, PageBreak,
    Table, TableStyle, NextPageTemplate, Flowable, Image as RLImage
)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.pdfmetrics import Font
from reportlab.pdfbase.ttfonts import TTFont

# ═══════════════════════════════════════════════════════════════════════
# FONTS — cross-platform font discovery (macOS / Linux / Windows)
# ═══════════════════════════════════════════════════════════════════════
import platform as _platform
_PLAT = _platform.system()  # "Darwin", "Linux", "Windows"

def _find_font(candidates):
    """Return first existing path from candidates list.
    Each candidate is either a string path or a (path, subfontIndex) tuple."""
    for c in candidates:
        path = c[0] if isinstance(c, tuple) else c
        if os.path.exists(path):
            return c
    return None

# Font candidates per role — ordered by preference, first match wins.
# Each role lists candidates for macOS, Windows, Linux in one flat list.
_FONT_CANDIDATES = {
    "Sans": [
        "/System/Library/Fonts/Supplemental/Arial.ttf",                          # macOS
        "C:/Windows/Fonts/arial.ttf",                                            # Windows
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",                       # Linux common
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
        "/usr/share/fonts/truetype/crosextra/Carlito-Regular.ttf",               # Linux Debian
        "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",                   # Linux Noto
        "/usr/share/fonts/noto/NotoSans-Regular.ttf",                            # Linux Fedora
    ],
    "SansBold": [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "C:/Windows/Fonts/arialbd.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
        "/usr/share/fonts/truetype/crosextra/Carlito-Bold.ttf",
        "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
        "/usr/share/fonts/noto/NotoSans-Bold.ttf",
    ],
    "SansIt": [
        "/System/Library/Fonts/Supplemental/Arial Italic.ttf",
        "C:/Windows/Fonts/ariali.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Italic.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Italic.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSansOblique.ttf",
        "/usr/share/fonts/truetype/crosextra/Carlito-Italic.ttf",
        "/usr/share/fonts/truetype/noto/NotoSans-Italic.ttf",
    ],
    "SansBI": [
        "/System/Library/Fonts/Supplemental/Arial Bold Italic.ttf",
        "C:/Windows/Fonts/arialbi.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-BoldItalic.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-BoldItalic.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSansBoldOblique.ttf",
        "/usr/share/fonts/truetype/crosextra/Carlito-BoldItalic.ttf",
        "/usr/share/fonts/truetype/noto/NotoSans-BoldItalic.ttf",
    ],
    "Serif": [
        ("/System/Library/Fonts/Palatino.ttc", 0),                               # macOS Palatino
        "C:/Windows/Fonts/times.ttf",                                            # Windows TNR
        "/usr/share/fonts/truetype/liberation2/LiberationSerif-Regular.ttf",     # Linux
        "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSerif.ttf",
        "/usr/share/fonts/truetype/noto/NotoSerif-Regular.ttf",
        "/usr/share/fonts/noto/NotoSerif-Regular.ttf",
    ],
    "SerifBold": [
        ("/System/Library/Fonts/Palatino.ttc", 2),
        "C:/Windows/Fonts/timesbd.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSerif-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSerifBold.ttf",
        "/usr/share/fonts/truetype/noto/NotoSerif-Bold.ttf",
    ],
    "SerifIt": [
        ("/System/Library/Fonts/Palatino.ttc", 1),
        "C:/Windows/Fonts/timesi.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSerif-Italic.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSerif-Italic.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Italic.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSerifItalic.ttf",
    ],
    "SerifBI": [
        ("/System/Library/Fonts/Palatino.ttc", 3),
        "C:/Windows/Fonts/timesbi.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSerif-BoldItalic.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSerif-BoldItalic.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSerif-BoldItalic.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSerifBoldItalic.ttf",
    ],
    "CJK": [
        ("/System/Library/Fonts/Supplemental/Songti.ttc", 0),                   # macOS Songti SC
        "C:/Windows/Fonts/simsun.ttc",                                           # Windows SimSun (宋体)
        "C:/Windows/Fonts/msyh.ttc",                                             # Windows MSYH (微软雅黑)
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
        "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",              # Linux Noto CJK
        "/usr/share/fonts/noto-cjk/NotoSerifCJK-Regular.ttc",                   # Linux Fedora
        "/usr/share/fonts/truetype/arphic/uming.ttc",
        "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
        "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
        "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",            # Linux Droid
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/unifont/unifont.ttf",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",                  # macOS fallback
    ],
    "CJKBold": [
        ("/System/Library/Fonts/Supplemental/Songti.ttc", 1),
        "C:/Windows/Fonts/simsunb.ttf",
        "C:/Windows/Fonts/msyhbd.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Bold.otf",
        "/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc",
        "/usr/share/fonts/noto-cjk/NotoSerifCJK-Bold.ttc",
        "/usr/share/fonts/truetype/arphic/uming.ttc",
        "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
        "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
    ],
    "Mono": [
        ("/System/Library/Fonts/Menlo.ttc", 0),                                  # macOS
        "C:/Windows/Fonts/consola.ttf",                                          # Windows Consolas
        "C:/Windows/Fonts/cour.ttf",                                             # Windows Courier New
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",                  # Linux
        "/usr/share/fonts/truetype/noto/NotoSansMono-Regular.ttf",
    ],
    "MonoBold": [
        ("/System/Library/Fonts/Menlo.ttc", 1),
        "C:/Windows/Fonts/consolab.ttf",
        "C:/Windows/Fonts/courbd.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
        "/usr/share/fonts/truetype/noto/NotoSansMono-Bold.ttf",
    ],
    "Emoji": [
        ("/System/Library/Fonts/Apple Color Emoji.ttc", 0),
        "C:/Windows/Fonts/seguiemj.ttf",
        "C:/Windows/Fonts/seguisym.ttf",
        "/usr/share/fonts/truetype/noto/NotoEmoji-Regular.ttf",
        "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
        "/usr/share/fonts/truetype/ancient-scripts/Symbola_hint.ttf",
    ],
}

_REGISTERED_TTF = set()
_EMOJI_FONT_REGISTERED = False

_BUILTIN_FONT_FALLBACKS = {
    "Sans": "Helvetica",
    "SansBold": "Helvetica-Bold",
    "SansIt": "Helvetica-Oblique",
    "SansBI": "Helvetica-BoldOblique",
    "Serif": "Times-Roman",
    "SerifBold": "Times-Bold",
    "SerifIt": "Times-Italic",
    "SerifBI": "Times-BoldItalic",
    "Mono": "Courier",
    "MonoBold": "Courier-Bold",
    "CJK": "Helvetica",
    "CJKBold": "Helvetica-Bold",
    "Emoji": "Helvetica",
}

def register_fonts():
    global _EMOJI_FONT_REGISTERED
    missing = []
    for name, candidates in _FONT_CANDIDATES.items():
        spec = _find_font(candidates)
        if spec is None:
            missing.append(name)
        else:
            try:
                if isinstance(spec, tuple):
                    pdfmetrics.registerFont(TTFont(name, spec[0], subfontIndex=spec[1]))
                else:
                    pdfmetrics.registerFont(TTFont(name, spec))
                _REGISTERED_TTF.add(name)
                if name == "Emoji":
                    _EMOJI_FONT_REGISTERED = True
                continue
            except Exception as e:
                missing.append(name)
                print(f"Warning: Font {name} — {e}", file=sys.stderr)
        base = _BUILTIN_FONT_FALLBACKS.get(name)
        if base:
            try:
                pdfmetrics.registerFont(Font(name, base, "WinAnsiEncoding"))
            except Exception:
                pass
    if missing:
        print(f"Warning: Missing fonts: {', '.join(missing)}. PDF may have □ characters.", file=sys.stderr)
        if _PLAT == "Linux":
            print("  Fix: sudo apt install fonts-dejavu-core fonts-liberation fonts-freefont-ttf fonts-noto fonts-noto-cjk fonts-noto-color-emoji", file=sys.stderr)
        elif _PLAT == "Windows":
            print("  Fix: Install Noto fonts from https://fonts.google.com/noto", file=sys.stderr)
    pdfmetrics.registerFontFamily("Sans", normal="Sans", bold="SansBold",
                                  italic="SansIt", boldItalic="SansBI")
    pdfmetrics.registerFontFamily("Serif", normal="Serif", bold="SerifBold",
                                  italic="SerifIt", boldItalic="SerifBI")

# ═══════════════════════════════════════════════════════════════════════
# THEMES — each theme has colors + layout for real typographic difference
# ═══════════════════════════════════════════════════════════════════════
# Layout keys:
#   margins: (left, right, top, bottom) in mm
#   body_font: "Serif" or "Sans"
#   body_size / body_leading: body text dimensions
#   h1_size / h2_size / h3_size: heading sizes
#   heading_align: TA_CENTER or TA_LEFT
#   heading_decoration: "rules" | "underline" | "dot" | "none"
#   header_style: "full" | "minimal" | "none"
#   code_style: "bg" (background fill) | "border" (left border only)
#   cover_style: "centered" | "left-aligned" | "minimal"
#   page_decoration: "none" | "top-bar" | "left-stripe" | "side-rule" | "corner-marks"

_DEFAULT_LAYOUT = {
    "margins": (25, 22, 28, 25),
    "body_font": "Serif", "body_size": 10.5, "body_leading": 17,
    "h1_size": 26, "h2_size": 18, "h3_size": 12,
    "heading_align": "center", "heading_decoration": "rules",
    "header_style": "full", "code_style": "bg", "cover_style": "centered",
    "page_decoration": "none",
}

THEMES = {
    "warm-academic": {
        "canvas":"#F9F9F7","canvas_sec":"#F0EEE6","ink":"#181818","ink_faded":"#87867F",
        "accent":"#CC785C","accent_light":"#D99A82","border":"#E8E6DC",
        "watermark_rgba":(0.82,0.80,0.76,0.12),
        "layout": {
            "body_font":"Serif","body_size":10.5,"body_leading":17,
            "heading_align":"center","heading_decoration":"rules",
            "header_style":"full","code_style":"bg","cover_style":"centered",
            "page_decoration":"top-bar",
        }
    },
    "nord-frost": {
        "canvas":"#ECEFF4","canvas_sec":"#E5E9F0","ink":"#2E3440","ink_faded":"#4C566A",
        "accent":"#5E81AC","accent_light":"#81A1C1","border":"#D8DEE9",
        "watermark_rgba":(0.74,0.78,0.85,0.10),
        "layout": {
            "body_font":"Sans","body_size":10,"body_leading":16,
            "h3_size":11,"heading_align":"left","heading_decoration":"underline",
            "header_style":"minimal","code_style":"border","cover_style":"left-aligned",
            "page_decoration":"left-stripe",
        }
    },
    "github-light": {
        "canvas":"#FFFFFF","canvas_sec":"#F6F8FA","ink":"#1F2328","ink_faded":"#656D76",
        "accent":"#0969DA","accent_light":"#218BFF","border":"#D0D7DE",
        "watermark_rgba":(0.80,0.82,0.85,0.08),
        "layout": {
            "body_font":"Sans","body_size":10,"body_leading":16.5,
            "heading_align":"left","heading_decoration":"none",
            "header_style":"minimal","code_style":"bg","cover_style":"left-aligned",
            "page_decoration":"left-stripe",
        }
    },
    "solarized-light": {
        "canvas":"#FDF6E3","canvas_sec":"#EEE8D5","ink":"#657B83","ink_faded":"#93A1A1",
        "accent":"#CB4B16","accent_light":"#DC322F","border":"#EEE8D5",
        "watermark_rgba":(0.85,0.82,0.72,0.10),
    },
    "paper-classic": {
        "canvas":"#FFFFFF","canvas_sec":"#FAFAFA","ink":"#000000","ink_faded":"#666666",
        "accent":"#CC0000","accent_light":"#FF3333","border":"#DDDDDD",
        "watermark_rgba":(0.85,0.85,0.85,0.08),
    },
    "ocean-breeze": {
        "canvas":"#F0F7F4","canvas_sec":"#E0EDE8","ink":"#1A2E35","ink_faded":"#5A7D7C",
        "accent":"#2A9D8F","accent_light":"#64CCBF","border":"#C8DDD6",
        "watermark_rgba":(0.75,0.85,0.80,0.10),
        "layout": {
            "body_font":"Sans","body_size":10.5,"body_leading":17,
            "heading_align":"left","heading_decoration":"underline",
            "header_style":"full","code_style":"bg","cover_style":"centered",
            "page_decoration":"top-bar",
        }
    },
    "monokai-warm": {
        "canvas":"#272822","canvas_sec":"#1E1F1C","ink":"#F8F8F2","ink_faded":"#75715E",
        "accent":"#F92672","accent_light":"#FD971F","border":"#49483E",
        "watermark_rgba":(0.30,0.30,0.28,0.08),
    },
    "dracula-soft": {
        "canvas":"#282A36","canvas_sec":"#21222C","ink":"#F8F8F2","ink_faded":"#6272A4",
        "accent":"#BD93F9","accent_light":"#FF79C6","border":"#44475A",
        "watermark_rgba":(0.35,0.30,0.45,0.08),
    },
    # --- Inspired by classic LaTeX templates ---
    "tufte": {
        "canvas":"#FFFFF8","canvas_sec":"#F7F7F0","ink":"#111111","ink_faded":"#999988",
        "accent":"#980000","accent_light":"#C04040","border":"#E0DDD0",
        "watermark_rgba":(0.88,0.87,0.82,0.08),
        "layout": {
            "margins":(30, 55, 25, 25),  # wide right margin (Tufte sidenote style)
            "body_font":"Serif","body_size":11,"body_leading":18,
            "h1_size":24,"h2_size":16,"h3_size":11,
            "heading_align":"left","heading_decoration":"none",
            "header_style":"none","code_style":"border","cover_style":"minimal",
            "page_decoration":"side-rule",
        }
    },
    "classic-thesis": {
        "canvas":"#FEFEFE","canvas_sec":"#F5F2EB","ink":"#2B2B2B","ink_faded":"#7A7568",
        "accent":"#8B4513","accent_light":"#A0522D","border":"#D6CFC2",
        "watermark_rgba":(0.82,0.78,0.72,0.10),
        "layout": {
            "body_font":"Serif","body_size":10.5,"body_leading":17,
            "h1_size":28,"h2_size":20,
            "heading_align":"center","heading_decoration":"rules",
            "header_style":"full","code_style":"bg","cover_style":"centered",
            "page_decoration":"corner-marks",
        }
    },
    "ieee-journal": {
        "canvas":"#FFFFFF","canvas_sec":"#F5F5F5","ink":"#000000","ink_faded":"#555555",
        "accent":"#003366","accent_light":"#336699","border":"#CCCCCC",
        "watermark_rgba":(0.82,0.82,0.82,0.08),
        "layout": {
            "margins":(20, 20, 22, 20),  # tight margins like journal papers
            "body_font":"Serif","body_size":9.5,"body_leading":14,
            "h1_size":22,"h2_size":14,"h3_size":11,
            "heading_align":"left","heading_decoration":"underline",
            "header_style":"minimal","code_style":"border","cover_style":"left-aligned",
            "page_decoration":"top-band",
        }
    },
    "elegant-book": {
        "canvas":"#FBF9F1","canvas_sec":"#F0ECE0","ink":"#1A1A1A","ink_faded":"#6E6B5E",
        "accent":"#5B3A29","accent_light":"#7D5642","border":"#DDD8C8",
        "watermark_rgba":(0.85,0.82,0.75,0.10),
        "layout": {
            "margins":(28, 24, 30, 28),  # generous margins for book feel
            "body_font":"Serif","body_size":10.5,"body_leading":18,
            "h1_size":28,"h2_size":20,
            "heading_align":"center","heading_decoration":"dot",
            "header_style":"full","code_style":"bg","cover_style":"centered",
            "page_decoration":"double-rule",
        }
    },
    "chinese-red": {
        "canvas":"#FFFDF5","canvas_sec":"#F8F0E0","ink":"#1A1009","ink_faded":"#8C7A5E",
        "accent":"#B22222","accent_light":"#D44040","border":"#E8DCC8",
        "watermark_rgba":(0.88,0.82,0.72,0.10),
        "layout": {
            "body_font":"Serif","body_size":11,"body_leading":18,
            "h1_size":28,"h2_size":20,
            "heading_align":"center","heading_decoration":"rules",
            "header_style":"full","code_style":"bg","cover_style":"centered",
            "page_decoration":"top-bar",
        }
    },
    "ink-wash": {
        "canvas":"#F8F6F0","canvas_sec":"#EEEAE0","ink":"#2C2C2C","ink_faded":"#8A8A80",
        "accent":"#404040","accent_light":"#666660","border":"#D8D4C8",
        "watermark_rgba":(0.80,0.80,0.76,0.10),
        "layout": {
            "margins":(30, 30, 30, 28),  # symmetric, generous whitespace
            "body_font":"Serif","body_size":10.5,"body_leading":18,
            "h1_size":24,"h2_size":16,"h3_size":11,
            "heading_align":"center","heading_decoration":"dot",
            "header_style":"none","code_style":"border","cover_style":"minimal",
            "page_decoration":"none",
        }
    },
}

def load_theme(name, theme_file=None):
    if theme_file and os.path.exists(theme_file):
        with open(theme_file) as f:
            t = json.load(f)
    elif name in THEMES:
        t = THEMES[name]
    else:
        print(f"Unknown theme '{name}', falling back to warm-academic", file=sys.stderr)
        t = THEMES["warm-academic"]
    # Merge layout with defaults
    layout = dict(_DEFAULT_LAYOUT)
    layout.update(t.get("layout", {}))
    return {
        "canvas":    HexColor(t["canvas"]),
        "canvas_sec":HexColor(t["canvas_sec"]),
        "ink":       HexColor(t["ink"]),
        "ink_faded": HexColor(t["ink_faded"]),
        "accent":    HexColor(t["accent"]),
        "accent_light":HexColor(t.get("accent_light", t["accent"])),
        "border":    HexColor(t["border"]),
        "wm_color":  Color(*t.get("watermark_rgba", (0.82,0.80,0.76,0.12))),
        "layout":    layout,
    }

# ═══════════════════════════════════════════════════════════════════════
# CJK / EMOJI DETECTION + FONT WRAPPING
# ═══════════════════════════════════════════════════════════════════════
_CJK_RANGES = [
    (0x2E80,0x2EFF),(0x2F00,0x2FDF),(0x3000,0x303F),(0x3400,0x4DBF),
    (0x4E00,0x9FFF),(0xF900,0xFAFF),(0xFE30,0xFE4F),(0xFF00,0xFFEF),
    (0x20000,0x2A6DF),(0x2A700,0x2B73F),(0x2B740,0x2B81F),
]
_CJK_STARTS = [lo for lo, hi in _CJK_RANGES]
_CJK_ENDS = [hi for lo, hi in _CJK_RANGES]

def _is_cjk(ch):
    cp = ord(ch)
    idx = _bisect_right(_CJK_STARTS, cp) - 1
    return idx >= 0 and cp <= _CJK_ENDS[idx]

_EMOJI_RANGES = [
    (0x1F000,0x1FAFF),(0x2600,0x27BF),(0x2300,0x23FF),(0x2B00,0x2BFF),
]
_EMOJI_TRAILING = set([0x200D, 0x20E3, 0xFE0E, 0xFE0F])
_TWEMOJI_CACHE = os.path.join(tempfile.gettempdir(), "any2pdf-twemoji")
_TWEMOJI_MISSES = set()

def _is_emoji_char(ch):
    cp = ord(ch)
    return any(lo <= cp <= hi for lo, hi in _EMOJI_RANGES) or 0x1F3FB <= cp <= 0x1F3FF

def _emoji_sequence(text, start):
    end = start + 1
    while end < len(text):
        cp = ord(text[end])
        if cp in _EMOJI_TRAILING or 0x1F3FB <= cp <= 0x1F3FF:
            end += 1
            continue
        if text[end - 1] == "\u200d" and _is_emoji_char(text[end]):
            end += 1
            continue
        break
    return text[start:end], end

def _emoji_codepoint(seq):
    cps = []
    for ch in seq:
        cp = ord(ch)
        if cp in (0xFE0E, 0xFE0F):
            continue
        cps.append(f"{cp:x}")
    return "-".join(cps)

def _esc_attr(text):
    return esc(str(text)).replace('"', "&quot;")

def _twemoji_path(seq):
    code = _emoji_codepoint(seq)
    if not code or code in _TWEMOJI_MISSES:
        return None
    os.makedirs(_TWEMOJI_CACHE, exist_ok=True)
    path = os.path.join(_TWEMOJI_CACHE, f"{code}.png")
    if os.path.exists(path):
        return path
    url = f"https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/{code}.png"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "any2pdf/1.0"})
        with urllib.request.urlopen(req, timeout=2.0) as resp:
            data = resp.read()
        if data:
            with open(path, "wb") as f:
                f.write(data)
            return path
    except Exception:
        _TWEMOJI_MISSES.add(code)
    return None

def _emoji_inline(text, size=10):
    """Replace supported emoji runs with cached Twemoji image tags."""
    out, i = [], 0
    while i < len(text):
        ch = text[i]
        if _is_emoji_char(ch):
            seq, end = _emoji_sequence(text, i)
            path = _twemoji_path(seq)
            if path:
                src = _esc_attr(path)
                out.append(f'<img src="{src}" width="{size}" height="{size}" valign="-2"/>')
            elif _EMOJI_FONT_REGISTERED:
                out.append(f"<font name='Emoji'>{seq}</font>")
            else:
                out.append(seq)
            i = end
        else:
            out.append(ch)
            i += 1
    return ''.join(out)

def _font_wrap_plain(text):
    out, buf, role = [], [], None
    for ch in text:
        if _is_cjk(ch):
            next_role = "CJK"
        elif _EMOJI_FONT_REGISTERED and (_is_emoji_char(ch) or (ord(ch) in _EMOJI_TRAILING and role == "Emoji")):
            next_role = "Emoji"
        else:
            next_role = None
        if next_role != role and buf:
            seg = ''.join(buf)
            out.append(f"<font name='{role}'>{seg}</font>" if role else seg)
            buf = []
        buf.append(ch); role = next_role
    if buf:
        seg = ''.join(buf)
        out.append(f"<font name='{role}'>{seg}</font>" if role else seg)
    return ''.join(out)

def _font_wrap(text):
    """Wrap CJK and locally available monochrome emoji runs without touching XML tags."""
    parts = re.split(r'(<[^>]+>)', text)
    return ''.join(p if p.startswith("<") and p.endswith(">") else _font_wrap_plain(p) for p in parts)

def _draw_mixed(c, x, y, text, size, anchor="left", max_w=0):
    """Draw mixed CJK/Latin text on canvas with font switching.
    If max_w > 0, wrap into multiple lines. Returns bottom y of drawn text."""
    if max_w > 0:
        return _draw_mixed_wrap(c, x, y, text, size, anchor, max_w)
    segs, buf, in_cjk = [], [], False
    for ch in text:
        cj = _is_cjk(ch)
        if cj != in_cjk and buf:
            segs.append(("CJK" if in_cjk else "Sans", ''.join(buf))); buf = []
        buf.append(ch); in_cjk = cj
    if buf: segs.append(("CJK" if in_cjk else "Sans", ''.join(buf)))
    total_w = sum(c.stringWidth(t, f, size) for f, t in segs)
    if anchor == "right": x -= total_w
    elif anchor == "center": x -= total_w / 2
    for font, txt in segs:
        c.setFont(font, size); c.drawString(x, y, txt)
        x += c.stringWidth(txt, font, size)

def _measure_mixed(c, text, size):
    """Measure width of mixed CJK/Latin text."""
    w = 0
    buf, in_cjk = [], False
    for ch in text:
        cj = _is_cjk(ch)
        if cj != in_cjk and buf:
            w += c.stringWidth(''.join(buf), "CJK" if in_cjk else "Sans", size); buf = []
        buf.append(ch); in_cjk = cj
    if buf: w += c.stringWidth(''.join(buf), "CJK" if in_cjk else "Sans", size)
    return w

def _draw_mixed_wrap(c, x, y, text, size, anchor, max_w):
    """Word-wrap mixed text into multiple lines, shrink font if single word overflows."""
    words = text.split(' ')
    # Shrink font until longest word fits (floor 16pt)
    while size > 16:
        longest = max(_measure_mixed(c, w, size) for w in words)
        if longest <= max_w: break
        size -= 1
    # Greedy line breaking
    lines, cur = [], []
    cur_w = 0
    space_w = c.stringWidth(' ', 'Sans', size)
    for word in words:
        ww = _measure_mixed(c, word, size)
        test_w = cur_w + (space_w if cur else 0) + ww
        if cur and test_w > max_w:
            lines.append(' '.join(cur)); cur = [word]; cur_w = ww
        else:
            cur.append(word); cur_w = test_w
    if cur: lines.append(' '.join(cur))
    # Draw lines downward from y (top line at y)
    line_h = size * 1.3
    for i, line in enumerate(lines):
        _draw_mixed(c, x, y - i * line_h, line, size, anchor)
    return y - (len(lines) - 1) * line_h

def _draw_mixed_segs(c, x, y, segs):
    """Draw pre-defined (font, text, size) segments on canvas.
    Used for mixed-font subtitle rendering."""
    total_w = sum(c.stringWidth(txt, font, sz) for font, txt, sz in segs)
    x = x - total_w / 2  # always centered
    for font, txt, sz in segs:
        c.setFont(font, sz)
        c.drawString(x, y, txt)
        x += c.stringWidth(txt, font, sz)

# ═══════════════════════════════════════════════════════════════════════
# INLINE MARKDOWN + ESCAPING
# ═══════════════════════════════════════════════════════════════════════
def esc(text):
    return text.replace("&","&amp;").replace("<","&lt;").replace(">","&gt;")

def esc_code(text):
    """Escape for code blocks: preserve indentation, alignment, and newlines."""
    out = []
    for line in text.split('\n'):
        e = esc(line)
        out.append(e.replace(' ', '&nbsp;'))
    return '<br/>'.join(out)

def md_inline(text, accent_hex="#CC785C"):
    text = esc(text)
    code_spans = []
    def _code_span(m):
        code_spans.append(rf"<font name='Mono' size='8' color='{accent_hex}'>{m.group(1)}</font>")
        return f"@@ANY2PDF_CODE_{len(code_spans) - 1}@@"
    text = re.sub(r'`(.+?)`', _code_span, text)
    text = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', text)
    text = re.sub(r'\\\((.+?)\\\)',
        rf"<font name='SerifIt' color='{accent_hex}'>\1</font>", text)
    text = re.sub(r'(?<!\\)\$(?!\$)(.+?)(?<!\\)\$',
        rf"<font name='SerifIt' color='{accent_hex}'>\1</font>", text)
    text = re.sub(r'(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)', r'<i>\1</i>', text)
    text = re.sub(r'(?<!!)\[(.+?)\]\(.+?\)', r'<u>\1</u>', text)
    text = _emoji_inline(text)
    for idx, html in enumerate(code_spans):
        text = text.replace(f"@@ANY2PDF_CODE_{idx}@@", html)
    return _font_wrap(text)

_MD_IMAGE_RE = re.compile(r'!\[([^\]]*)\]\(([^)]+)\)')

# ═══════════════════════════════════════════════════════════════════════
# CUSTOM FLOWABLES
# ═══════════════════════════════════════════════════════════════════════
_anchor_counter = [0]
_outline_level = [-1]
_cur_chapter = [""]

class ChapterMark(Flowable):
    width = height = 0
    def __init__(self, t, level=0):
        Flowable.__init__(self); self.title = t; self.level = level
        _anchor_counter[0] += 1; self.key = f"anchor_{_anchor_counter[0]}"
    def draw(self):
        _cur_chapter[0] = self.title
        self.canv.bookmarkPage(self.key)
        target = min(self.level, _outline_level[0] + 1)
        _outline_level[0] = target
        self.canv.addOutlineEntry(self.title, self.key, level=target, closed=(target==0))

class HRule(Flowable):
    def __init__(self, w, thick=0.5, clr=None):
        Flowable.__init__(self)
        self.width = w; self.height = 4*mm; self._t = thick; self._c = clr or HexColor("#E8E6DC")
    def draw(self):
        self.canv.setStrokeColor(self._c); self.canv.setLineWidth(self._t)
        self.canv.line(0, 2*mm, self.width, 2*mm)

class HRuleCentered(Flowable):
    """Horizontally centered rule within the frame width."""
    def __init__(self, frame_w, rule_w, thick=0.5, clr=None):
        Flowable.__init__(self)
        self.width = frame_w; self.height = 4*mm
        self._rw = rule_w; self._t = thick; self._c = clr or HexColor("#E8E6DC")
    def draw(self):
        self.canv.setStrokeColor(self._c); self.canv.setLineWidth(self._t)
        x0 = (self.width - self._rw) / 2
        self.canv.line(x0, 2*mm, x0 + self._rw, 2*mm)

class ClayDot(Flowable):
    """Small accent-colored dot separator."""
    def __init__(self, w, clr=None):
        Flowable.__init__(self)
        self.width = w; self.height = 6*mm
        self._c = clr or HexColor("#CC785C")
    def draw(self):
        self.canv.setFillColor(self._c)
        cx = self.width / 2
        self.canv.circle(cx, 3*mm, 1.5*mm, fill=1, stroke=0)

class LeftBorderParagraph(Flowable):
    """Paragraph with a left accent border line (for code blocks in 'border' style)."""
    def __init__(self, para, border_color, border_width=2):
        Flowable.__init__(self)
        self._para = para
        self._bc = border_color; self._bw = border_width
    def wrap(self, aw, ah):
        w, h = self._para.wrap(aw, ah)
        self.width = w; self.height = h
        return w, h
    def draw(self):
        self._para.drawOn(self.canv, 0, 0)
        self.canv.setStrokeColor(self._bc); self.canv.setLineWidth(self._bw)
        self.canv.line(2, -2, 2, self.height + 2)

# ═══════════════════════════════════════════════════════════════════════
# PDF BUILDER
# ═══════════════════════════════════════════════════════════════════════
class PDFBuilder:
    def __init__(self, config):
        self.cfg = config
        self.T = config["theme"]  # resolved theme colors
        self.L = self.T["layout"]  # layout parameters
        self.page_w, self.page_h = config["page_size"]
        lm, rm, tm, bm = self.L["margins"]
        self.lm, self.rm, self.tm, self.bm = lm*mm, rm*mm, tm*mm, bm*mm
        self.body_w = self.page_w - self.lm - self.rm
        self.body_h = self.page_h - self.tm - self.bm
        self.accent_hex = config.get("accent_hex", "#CC785C")
        self.ST = self._build_styles()

    def _build_styles(self):
        T = self.T; L = self.L
        s = {}
        bf = L["body_font"]  # "Serif" or "Sans"
        bs, bl = L["body_size"], L["body_leading"]
        h_align = TA_CENTER if L["heading_align"] == "center" else TA_LEFT
        s['part'] = ParagraphStyle('Part', fontName="Serif", fontSize=L["h1_size"],
            leading=L["h1_size"]+10, textColor=T["ink"], alignment=h_align,
            spaceBefore=0, spaceAfter=0)
        s['chapter'] = ParagraphStyle('Ch', fontName="Serif", fontSize=L["h2_size"],
            leading=L["h2_size"]+8, textColor=T["ink"], alignment=h_align,
            spaceBefore=0, spaceAfter=0)
        s['h3'] = ParagraphStyle('H3', fontName="SansBold", fontSize=L["h3_size"],
            leading=L["h3_size"]+5, textColor=T["accent"], alignment=TA_LEFT,
            spaceBefore=10, spaceAfter=4)
        s['h4'] = ParagraphStyle('H4', fontName="SansBold", fontSize=max(L["h3_size"] - 1, 9),
            leading=max(L["h3_size"] + 3, 12), textColor=T["ink"], alignment=TA_LEFT,
            spaceBefore=8, spaceAfter=3)
        s['h5'] = ParagraphStyle('H5', fontName="SansBold", fontSize=max(L["h3_size"] - 2, 8.5),
            leading=max(L["h3_size"] + 2, 11), textColor=T["ink_faded"], alignment=TA_LEFT,
            spaceBefore=6, spaceAfter=2)
        s['body'] = ParagraphStyle('Body', fontName=bf, fontSize=bs, leading=bl,
            textColor=T["ink"], alignment=TA_JUSTIFY, spaceBefore=2, spaceAfter=4,
            wordWrap='CJK')
        s['body_indent'] = ParagraphStyle('BI', parent=s['body'],
            leftIndent=14, rightIndent=14, textColor=T["ink_faded"],
            borderColor=T["accent"], borderWidth=0, borderPadding=4)
        s['callout_title'] = ParagraphStyle('CalloutTitle', fontName="SansBold",
            fontSize=max(bs, 9.5), leading=bl, textColor=T["ink"],
            alignment=TA_LEFT, spaceBefore=0, spaceAfter=2, wordWrap='CJK')
        s['callout_body'] = ParagraphStyle('CalloutBody', fontName=bf,
            fontSize=bs, leading=bl, textColor=T["ink"], alignment=TA_LEFT,
            spaceBefore=0, spaceAfter=0, wordWrap='CJK')
        s['caption'] = ParagraphStyle('Caption', fontName="Sans", fontSize=8.5,
            leading=11, textColor=T["ink_faded"], alignment=TA_CENTER,
            spaceBefore=3, spaceAfter=6, wordWrap='CJK')
        s['math'] = ParagraphStyle('MathFallback', fontName="Mono", fontSize=8.8,
            leading=12, textColor=T["accent"], alignment=TA_CENTER,
            spaceBefore=6, spaceAfter=6, wordWrap='CJK')
        s['bullet'] = ParagraphStyle('Bul', fontName=bf, fontSize=bs, leading=bl,
            textColor=T["ink"], alignment=TA_LEFT, spaceBefore=1, spaceAfter=1,
            leftIndent=18, bulletIndent=6, wordWrap='CJK')
        # Code block: "bg" = background fill, "border" = left accent line (no bg)
        self._code_style_type = L["code_style"]
        if L["code_style"] == "border":
            s['code'] = ParagraphStyle('Code', fontName="Mono", fontSize=7.5, leading=10.5,
                textColor=HexColor("#3D3D3A"), alignment=TA_LEFT, spaceBefore=4, spaceAfter=4,
                leftIndent=14, rightIndent=8, backColor=None,
                borderColor=None, borderWidth=0, borderPadding=6)
        else:
            s['code'] = ParagraphStyle('Code', fontName="Mono", fontSize=7.5, leading=10.5,
                textColor=HexColor("#3D3D3A"), alignment=TA_LEFT, spaceBefore=4, spaceAfter=4,
                leftIndent=8, rightIndent=8, backColor=T["canvas_sec"],
                borderColor=T["border"], borderWidth=0.5, borderPadding=6)
        s['toc1'] = ParagraphStyle('T1', fontName="Serif", fontSize=12, leading=20,
            textColor=T["ink"], leftIndent=0, spaceBefore=6, spaceAfter=2)
        s['toc2'] = ParagraphStyle('T2', fontName="Sans", fontSize=10, leading=16,
            textColor=T["ink_faded"], leftIndent=16, spaceBefore=1, spaceAfter=1)
        s['th'] = ParagraphStyle('TH', fontName="SansBold", fontSize=8.5, leading=12,
            textColor=white, alignment=TA_CENTER)
        s['tc'] = ParagraphStyle('TC', fontName="Sans", fontSize=8, leading=11,
            textColor=T["ink"], alignment=TA_LEFT)
        return s

    # ── Page callbacks ──
    def _draw_bg(self, c):
        c.setFillColor(self.T["canvas"])
        c.rect(0, 0, self.page_w, self.page_h, fill=1, stroke=0)

    def _cover_page(self, c, doc):
        c.saveState(); self._draw_bg(c)
        T = self.T; cx = self.page_w / 2
        cover = self.L["cover_style"]

        if cover == "left-aligned":
            self._cover_left_aligned(c, T, cx)
        elif cover == "minimal":
            self._cover_minimal(c, T, cx)
        else:
            self._cover_centered(c, T, cx)

        c.restoreState()

    def _cover_centered(self, c, T, cx):
        """Classic centered cover with accent bars and rule."""
        # Top accent bar
        c.setFillColor(T["accent"])
        c.rect(0, self.page_h - 3*mm, self.page_w, 3*mm, fill=1, stroke=0)

        title_y = self.page_h * 0.62
        c.setFillColor(T["ink"])
        btm = _draw_mixed(c, cx, title_y, self.cfg.get("title", "Document"), 38, anchor="center", max_w=self.page_w - 40*mm)

        ver = self.cfg.get("version", "")
        if ver:
            c.setFillColor(T["accent"]); c.setFont("Sans", 13)
            c.drawCentredString(cx, btm - 30, ver)

        rule_y = btm - 52
        c.setStrokeColor(T["accent"]); c.setLineWidth(1.5)
        c.line(cx - 17*mm, rule_y, cx + 17*mm, rule_y)

        sub = self.cfg.get("subtitle", "")
        sub_segs = self.cfg.get("subtitle_segs")
        if sub_segs:
            c.setFillColor(T["ink_faded"]); _draw_mixed_segs(c, cx, rule_y - 32, sub_segs)
        elif sub:
            c.setFillColor(T["ink"]); _draw_mixed(c, cx, rule_y - 32, sub, 20, anchor="center")

        stats = self.cfg.get("stats_line", "")
        stats2 = self.cfg.get("stats_line2", "")
        if stats or stats2:
            c.setFillColor(T["ink_faded"]); stats_y = rule_y - 72
            if stats: _draw_mixed(c, cx, stats_y, stats, 9.5, anchor="center")
            if stats2: _draw_mixed(c, cx, stats_y - 18, stats2, 9.5, anchor="center")

        c.setStrokeColor(T["border"]); c.setLineWidth(0.5)
        c.line(self.lm + 20*mm, 52*mm, self.page_w - self.rm - 20*mm, 52*mm)

        author = self.cfg.get("author", "")
        if author:
            c.setFillColor(T["ink_faded"]); _draw_mixed(c, cx, 38*mm, author, 10, anchor="center")

        dt = self.cfg.get("date", str(date.today()))
        c.setFillColor(T["ink_faded"]); _draw_mixed(c, cx, 28*mm, dt, 9, anchor="center")

        edition = self.cfg.get("edition_line", "")
        if edition:
            c.setFillColor(T["ink_faded"]); _draw_mixed(c, cx, 20*mm, edition, 7.5, anchor="center")

        c.setFillColor(T["accent"])
        c.rect(0, 0, self.page_w, 3*mm, fill=1, stroke=0)

    def _cover_left_aligned(self, c, T, cx):
        """Modern left-aligned cover (GitHub/IEEE style)."""
        # Thick left accent stripe
        c.setFillColor(T["accent"])
        c.rect(0, 0, 6*mm, self.page_h, fill=1, stroke=0)

        lx = 25*mm  # left text x
        title_y = self.page_h * 0.58
        c.setFillColor(T["ink"])
        btm = _draw_mixed(c, lx, title_y, self.cfg.get("title", "Document"), 34, anchor="left", max_w=self.page_w - lx - 20*mm)

        ver = self.cfg.get("version", "")
        if ver:
            c.setFillColor(T["accent"]); c.setFont("Sans", 12)
            c.drawString(lx, btm - 28, ver)

        # Accent underline
        c.setStrokeColor(T["accent"]); c.setLineWidth(2)
        c.line(lx, btm - 42, lx + 50*mm, btm - 42)

        sub = self.cfg.get("subtitle", "")
        sub_segs = self.cfg.get("subtitle_segs")
        if sub_segs:
            c.setFillColor(T["ink_faded"]); _draw_mixed_segs(c, lx + 40*mm, btm - 62, sub_segs)
        elif sub:
            c.setFillColor(T["ink_faded"]); _draw_mixed(c, lx, btm - 62, sub, 16, anchor="left")

        stats = self.cfg.get("stats_line", "")
        stats2 = self.cfg.get("stats_line2", "")
        if stats or stats2:
            c.setFillColor(T["ink_faded"]); stats_y = btm - 100
            if stats: _draw_mixed(c, lx, stats_y, stats, 9, anchor="left")
            if stats2: _draw_mixed(c, lx, stats_y - 16, stats2, 9, anchor="left")

        # Bottom left info block
        author = self.cfg.get("author", "")
        if author:
            c.setFillColor(T["ink_faded"]); _draw_mixed(c, lx, 38*mm, author, 10, anchor="left")
        dt = self.cfg.get("date", str(date.today()))
        c.setFillColor(T["ink_faded"]); _draw_mixed(c, lx, 28*mm, dt, 9, anchor="left")

        edition = self.cfg.get("edition_line", "")
        if edition:
            c.setFillColor(T["ink_faded"]); _draw_mixed(c, lx, 20*mm, edition, 7.5, anchor="left")

    def _cover_minimal(self, c, T, cx):
        """Minimal cover (Tufte/ink-wash style) — lots of whitespace, no bars."""
        title_y = self.page_h * 0.50
        c.setFillColor(T["ink"])
        btm = _draw_mixed(c, cx, title_y, self.cfg.get("title", "Document"), 32, anchor="center", max_w=self.page_w - 50*mm)

        sub = self.cfg.get("subtitle", "")
        sub_segs = self.cfg.get("subtitle_segs")
        if sub_segs:
            c.setFillColor(T["ink_faded"]); _draw_mixed_segs(c, cx, btm - 36, sub_segs)
        elif sub:
            c.setFillColor(T["ink_faded"]); _draw_mixed(c, cx, btm - 36, sub, 16, anchor="center")

        ver = self.cfg.get("version", "")
        if ver:
            c.setFillColor(T["ink_faded"]); c.setFont("Sans", 10)
            c.drawCentredString(cx, btm - 60, ver)

        # Simple thin rule
        c.setStrokeColor(T["border"]); c.setLineWidth(0.3)
        c.line(cx - 25*mm, btm - 75, cx + 25*mm, btm - 75)

        author = self.cfg.get("author", "")
        if author:
            c.setFillColor(T["ink_faded"]); _draw_mixed(c, cx, 35*mm, author, 10, anchor="center")
        dt = self.cfg.get("date", str(date.today()))
        c.setFillColor(T["ink_faded"]); _draw_mixed(c, cx, 25*mm, dt, 9, anchor="center")

    def _frontispiece_page(self, c, doc):
        """Full-page image page after cover."""
        c.saveState(); self._draw_bg(c)
        fp = self.cfg.get("frontispiece", "")
        if fp and os.path.exists(fp):
            margin = 18*mm
            avail_w = self.page_w - 2 * margin
            avail_h = self.page_h - 2 * margin
            try:
                c.drawImage(fp, margin, margin, width=avail_w, height=avail_h,
                            preserveAspectRatio=True, anchor='c', mask='auto')
            except Exception:
                pass
        c.restoreState()

    def _backcover_page(self, c, doc):
        """Back cover with banner branding."""
        c.saveState(); self._draw_bg(c)
        T = self.T; cx = self.page_w / 2

        # Top accent
        c.setFillColor(T["accent"])
        c.rect(0, self.page_h - 3*mm, self.page_w, 3*mm, fill=1, stroke=0)

        # Banner image — centered
        banner = self.cfg.get("banner", "")
        if banner and os.path.exists(banner):
            cy = self.page_h / 2
            banner_w = 150*mm
            banner_h = banner_w / 2.57
            banner_x = (self.page_w - banner_w) / 2
            banner_y = cy - banner_h / 2 + 15*mm
            try:
                c.drawImage(banner, banner_x, banner_y, width=banner_w,
                            height=banner_h, preserveAspectRatio=True, mask='auto')
            except Exception:
                pass

        # Bottom disclaimer
        disclaimer = self.cfg.get("disclaimer", "")
        if disclaimer:
            c.setFillColor(T["ink_faded"])
            _draw_mixed(c, cx, 32*mm, disclaimer, 8.5, anchor="center")

        # Copyright
        copyright_text = self.cfg.get("copyright", "")
        if copyright_text:
            c.setFillColor(T["ink_faded"])
            _draw_mixed(c, cx, 20*mm, copyright_text, 8.5, anchor="center")

        # Bottom accent
        c.setFillColor(T["accent"])
        c.rect(0, 0, self.page_w, 3*mm, fill=1, stroke=0)

        c.restoreState()

    def _draw_page_decoration(self, c):
        """Draw theme-specific page decorations visible even at thumbnail size."""
        T = self.T; deco = self.L.get("page_decoration", "none")
        if deco == "top-bar":
            # Thin accent bar at very top of page
            c.setFillColor(T["accent"])
            c.rect(0, self.page_h - 2.5*mm, self.page_w, 2.5*mm, fill=1, stroke=0)
        elif deco == "left-stripe":
            # Thick colored stripe on left edge
            c.setFillColor(T["accent"])
            c.rect(0, 0, 5*mm, self.page_h, fill=1, stroke=0)
        elif deco == "side-rule":
            # Thin vertical rule on left side (Tufte-style margin line)
            c.setStrokeColor(T["border"]); c.setLineWidth(0.4)
            c.line(self.lm - 5*mm, self.bm, self.lm - 5*mm, self.page_h - self.tm + 5*mm)
        elif deco == "corner-marks":
            # Decorative corner brackets
            c.setStrokeColor(T["accent"]); c.setLineWidth(0.8)
            m = 12*mm; clen = 12*mm
            # Top-left
            c.line(m, self.page_h - m, m + clen, self.page_h - m)
            c.line(m, self.page_h - m, m, self.page_h - m - clen)
            # Top-right
            c.line(self.page_w - m, self.page_h - m, self.page_w - m - clen, self.page_h - m)
            c.line(self.page_w - m, self.page_h - m, self.page_w - m, self.page_h - m - clen)
            # Bottom-left
            c.line(m, m, m + clen, m)
            c.line(m, m, m, m + clen)
            # Bottom-right
            c.line(self.page_w - m, m, self.page_w - m - clen, m)
            c.line(self.page_w - m, m, self.page_w - m, m + clen)
        elif deco == "top-band":
            # Wide accent band at top (IEEE-style)
            c.setFillColor(T["accent"])
            c.rect(0, self.page_h - 8*mm, self.page_w, 8*mm, fill=1, stroke=0)
            # White text header inside band
            header_title = self.cfg.get("header_title", "")
            if header_title:
                c.setFillColor(white)
                _draw_mixed(c, self.lm, self.page_h - 6*mm, header_title, 7.5)
            doc_title = self.cfg.get("title", "")
            if doc_title:
                c.setFillColor(white)
                _draw_mixed(c, self.page_w - self.rm, self.page_h - 6*mm, doc_title[:40], 7.5, anchor="right")
        elif deco == "double-rule":
            # Double horizontal rules at top and bottom (elegant book style)
            c.setStrokeColor(T["accent"]); c.setLineWidth(0.6)
            y_top = self.page_h - 14*mm
            c.line(self.lm, y_top, self.page_w - self.rm, y_top)
            c.line(self.lm, y_top - 2*mm, self.page_w - self.rm, y_top - 2*mm)
            y_bot = self.bm - 4*mm
            c.line(self.lm, y_bot, self.page_w - self.rm, y_bot)
            c.line(self.lm, y_bot + 2*mm, self.page_w - self.rm, y_bot + 2*mm)

    def _normal_page(self, c, doc):
        self._draw_bg(c); pg = c.getPageNumber()
        c.saveState()
        T = self.T; hs = self.L["header_style"]

        # Page decoration (drawn first, behind content)
        self._draw_page_decoration(c)

        # Watermark
        wm = self.cfg.get("watermark", "")
        if wm:
            c.setFont("CJK", 52); c.setFillColor(T["wm_color"])
            c.translate(self.page_w/2, self.page_h/2); c.rotate(35)
            for dy in range(-300, 400, 160):
                for dx in range(-400, 500, 220):
                    c.drawCentredString(dx, dy, wm)
            c.rotate(-35); c.translate(-self.page_w/2, -self.page_h/2)

        # Header (skip if top-band decoration already drew header)
        deco = self.L.get("page_decoration", "none")
        if hs == "full" and deco != "top-band":
            c.setStrokeColor(T["border"]); c.setLineWidth(0.5)
            c.line(self.lm, self.page_h - 20*mm, self.page_w - self.rm, self.page_h - 20*mm)
            c.setFillColor(T["ink_faded"])
            header_title = self.cfg.get("header_title", "")
            if header_title:
                _draw_mixed(c, self.lm, self.page_h - 18*mm, header_title, 8)
            doc_title = self.cfg.get("title", "")
            if doc_title:
                _draw_mixed(c, self.page_w - self.rm, self.page_h - 18*mm, doc_title[:40], 8, anchor="right")
        elif hs == "minimal" and deco != "top-band":
            c.setFillColor(T["ink_faded"]); c.setFont("Sans", 8)
            c.drawRightString(self.page_w - self.rm, self.page_h - 16*mm, str(pg))

        # Footer (skip line if double-rule decoration already drew it)
        if hs != "none" and deco not in ("double-rule",):
            c.setStrokeColor(T["border"])
            c.line(self.lm, self.bm - 8*mm, self.page_w - self.rm, self.bm - 8*mm)

        # Footer center: page number
        if hs == "full":
            c.setFillColor(T["accent"]); c.setFont("Serif", 9)
            c.drawCentredString(self.page_w/2, self.bm - 16*mm, f"\u2014  {pg}  \u2014")
        elif hs == "minimal":
            c.setFillColor(T["ink_faded"]); c.setFont("Sans", 8)
            c.drawCentredString(self.page_w/2, self.bm - 14*mm, str(pg))
        elif hs == "none":
            c.setFillColor(T["ink_faded"]); c.setFont("Serif", 8)
            c.drawCentredString(self.page_w/2, self.bm - 10*mm, str(pg))

        # Footer left/right
        if hs == "full":
            footer_left = self.cfg.get("footer_left", self.cfg.get("author", ""))
            if footer_left:
                c.setFillColor(T["ink_faded"])
                _draw_mixed(c, self.lm, self.bm - 16*mm, footer_left, 8)
            c.setFillColor(T["ink_faded"])
            _draw_mixed(c, self.page_w - self.rm, self.bm - 16*mm,
                        self.cfg.get("date", str(date.today())), 8, anchor="right")
        c.restoreState()

    def _toc_page(self, c, doc):
        self._draw_bg(c); pg = c.getPageNumber()
        c.saveState()
        T = self.T

        # Header line
        c.setStrokeColor(T["border"]); c.setLineWidth(0.5)
        c.line(self.lm, self.page_h - 20*mm, self.page_w - self.rm, self.page_h - 20*mm)
        c.setFillColor(T["ink_faded"])

        # Header left: report title
        header_title = self.cfg.get("header_title", "")
        if header_title:
            _draw_mixed(c, self.lm, self.page_h - 18*mm, header_title, 8)

        # Header right: "目  录"
        c.setFont("CJK", 8)
        c.drawRightString(self.page_w - self.rm, self.page_h - 18*mm, "\u76ee  \u5f55")

        # Footer
        c.setStrokeColor(T["border"])
        c.line(self.lm, self.bm - 8*mm, self.page_w - self.rm, self.bm - 8*mm)
        c.setFillColor(T["accent"]); c.setFont("Serif", 9)
        c.drawCentredString(self.page_w/2, self.bm - 16*mm, f"\u2014  {pg}  \u2014")

        c.restoreState()

    # ── Rich block helpers ──
    @staticmethod
    def _blend_color(fg, bg, amount):
        return Color(
            fg.red * amount + bg.red * (1 - amount),
            fg.green * amount + bg.green * (1 - amount),
            fg.blue * amount + bg.blue * (1 - amount),
            1,
        )

    @staticmethod
    def _hex_color(c):
        return f"#{int(c.red*255):02x}{int(c.green*255):02x}{int(c.blue*255):02x}"

    def _clean_image_src(self, raw):
        src = raw.strip()
        if src.startswith("<") and ">" in src:
            return src[1:src.index(">")]
        quoted_title = re.search(r'\s+["\']', src)
        if quoted_title:
            src = src[:quoted_title.start()]
        return src.strip()

    def _resolve_image_source(self, src):
        src = self._clean_image_src(src)
        parsed = urllib.parse.urlparse(src)
        if parsed.scheme in ("http", "https"):
            cache_dir = os.path.join(tempfile.gettempdir(), "any2pdf-images")
            os.makedirs(cache_dir, exist_ok=True)
            ext = os.path.splitext(parsed.path)[1].lower()
            if ext not in (".png", ".jpg", ".jpeg", ".gif", ".bmp"):
                ext = ".img"
            path = os.path.join(cache_dir, hashlib.sha1(src.encode("utf-8")).hexdigest() + ext)
            if not os.path.exists(path):
                req = urllib.request.Request(src, headers={"User-Agent": "any2pdf/1.0"})
                with urllib.request.urlopen(req, timeout=10) as resp:
                    data = resp.read()
                with open(path, "wb") as f:
                    f.write(data)
            return path
        if parsed.scheme == "file":
            return urllib.request.url2pathname(parsed.path)
        path = os.path.expanduser(urllib.parse.unquote(src))
        if not os.path.isabs(path):
            path = os.path.join(self.cfg.get("input_dir", os.getcwd()), path)
        return path

    def _image_flowables(self, src, alt=""):
        ST = self.ST
        clean_src = self._clean_image_src(src)
        try:
            path = self._resolve_image_source(clean_src)
            if not os.path.exists(path):
                raise FileNotFoundError(path)
            iw, ih = ImageReader(path).getSize()
            max_w, max_h = self.body_w, self.body_h * 0.58
            scale = min(max_w / iw, max_h / ih, 1.0)
            img = RLImage(path, width=iw * scale, height=ih * scale)
            img.hAlign = "CENTER"
            flowables = [Spacer(1, 2*mm), img]
            if alt:
                flowables.append(Paragraph(md_inline(alt, self.accent_hex), ST['caption']))
            flowables.append(Spacer(1, 2*mm))
            return flowables
        except Exception as e:
            label = alt or clean_src
            msg = f"[Image omitted: {label} ({e})]"
            return [Paragraph(md_inline(msg, self.accent_hex), ST['body_indent'])]

    def _append_image_line(self, story, line):
        pos = 0
        for m in _MD_IMAGE_RE.finditer(line):
            before = line[pos:m.start()].strip()
            if before:
                story.append(Paragraph(md_inline(before, self.accent_hex), self.ST['body']))
            story.extend(self._image_flowables(m.group(2), m.group(1).strip()))
            pos = m.end()
        after = line[pos:].strip()
        if after:
            story.append(Paragraph(md_inline(after, self.accent_hex), self.ST['body']))

    def _math_flowable(self, expr):
        expr = expr.strip()
        if not expr:
            return Spacer(1, 0)
        image = self._render_math_image(expr)
        if image:
            image.hAlign = "CENTER"
            return image
        fallback = f"$$ {expr} $$"
        return Paragraph(_font_wrap(esc_code(fallback)), self.ST['math'])

    def _render_math_image(self, expr):
        try:
            import matplotlib
            matplotlib.use("Agg", force=True)
            import matplotlib.pyplot as plt
        except Exception:
            return None
        try:
            fig = plt.figure(figsize=(0.1, 0.1), dpi=200)
            txt = fig.text(0, 0, f"${expr}$", fontsize=13, color=self._hex_color(self.T["ink"]))
            fig.canvas.draw()
            bbox = txt.get_window_extent(renderer=fig.canvas.get_renderer())
            width = max((bbox.width + 16) / 200, 0.2)
            height = max((bbox.height + 16) / 200, 0.2)
            fig.set_size_inches(width, height)
            txt.set_position((8 / (width * 200), 8 / (height * 200)))
            buf = io.BytesIO()
            fig.savefig(buf, format="png", transparent=True, dpi=200, bbox_inches="tight", pad_inches=0.03)
            plt.close(fig)
            data = buf.getvalue()
            iw, ih = ImageReader(io.BytesIO(data)).getSize()
            natural_w, natural_h = iw * 72 / 200, ih * 72 / 200
            scale = min(self.body_w * 0.9 / natural_w, 1.0)
            img = RLImage(io.BytesIO(data), width=natural_w * scale, height=natural_h * scale)
            img._any2pdf_image_data = data
            return img
        except Exception:
            try:
                plt.close("all")
            except Exception:
                pass
            return None

    def _consume_math_block(self, lines, i):
        stripped = lines[i].strip()
        start, end = ("$$", "$$") if stripped.startswith("$$") else ("\\[", "\\]")
        body = stripped[len(start):].strip()
        if body.endswith(end) and len(body) > len(end):
            return body[:-len(end)].strip(), i + 1
        parts = [body] if body else []
        i += 1
        while i < len(lines):
            cur = lines[i].strip()
            if cur.endswith(end):
                tail = cur[:-len(end)].strip()
                if tail:
                    parts.append(tail)
                i += 1
                break
            parts.append(lines[i])
            i += 1
        return "\n".join(parts).strip(), i

    def _consume_callout(self, lines, i):
        m = re.match(r'^>\s*\[!([A-Za-z]+)\][+-]?\s*(.*)$', lines[i].strip())
        if not m:
            return None, i
        kind = m.group(1).upper()
        title = m.group(2).strip() or kind.title()
        body, i = [], i + 1
        while i < len(lines):
            raw = lines[i].rstrip()
            stripped = raw.strip()
            if stripped == ">":
                body.append("")
                i += 1
                continue
            if stripped.startswith(">"):
                body.append(re.sub(r'^\s*>\s?', '', raw))
                i += 1
                continue
            break
        return self._build_callout(kind, title, body), i

    def _build_callout(self, kind, title, body_lines):
        color_map = {
            "NOTE": "#0969DA", "INFO": "#0969DA", "TODO": "#0969DA",
            "TIP": "#1A7F37", "HINT": "#1A7F37", "SUCCESS": "#1A7F37", "CHECK": "#1A7F37", "DONE": "#1A7F37",
            "IMPORTANT": "#8250DF", "EXAMPLE": "#8250DF",
            "WARNING": "#9A6700", "CAUTION": "#D1242F", "DANGER": "#D1242F", "ERROR": "#D1242F", "BUG": "#D1242F",
            "QUESTION": "#57606A", "QUOTE": "#57606A", "CITE": "#57606A",
            "ABSTRACT": "#57606A", "SUMMARY": "#57606A", "TLDR": "#57606A",
            "FAILURE": "#D1242F", "FAIL": "#D1242F", "MISSING": "#D1242F",
        }
        accent = HexColor(color_map.get(kind, self._hex_color(self.T["accent"])))
        bg = self._blend_color(accent, self.T["canvas"], 0.10)
        border = self._blend_color(accent, self.T["canvas"], 0.55)
        title_html = f"<font name='SansBold' color='{self._hex_color(accent)}'>{md_inline(title, self.accent_hex)}</font>"
        rendered = [title_html]
        for line in body_lines:
            stripped = line.strip()
            if not stripped:
                rendered.append("")
            elif stripped.startswith(("- ", "* ")):
                rendered.append(f"&#8226;&nbsp;{md_inline(stripped[2:].strip(), self.accent_hex)}")
            else:
                num = re.match(r'^(\d+)\.\s+(.+)', stripped)
                if num:
                    rendered.append(f"{num.group(1)}.&nbsp;{md_inline(num.group(2), self.accent_hex)}")
                else:
                    rendered.append(md_inline(stripped, self.accent_hex))
        para = Paragraph("<br/>".join(rendered), self.ST['callout_body'])
        table = Table([[para]], colWidths=[self.body_w])
        table.setStyle(TableStyle([
            ('BACKGROUND',(0,0),(-1,-1), bg),
            ('BOX',(0,0),(-1,-1), 0.4, border),
            ('LINEBEFORE',(0,0),(0,-1), 3, accent),
            ('LEFTPADDING',(0,0),(-1,-1),8),
            ('RIGHTPADDING',(0,0),(-1,-1),8),
            ('TOPPADDING',(0,0),(-1,-1),6),
            ('BOTTOMPADDING',(0,0),(-1,-1),6),
            ('VALIGN',(0,0),(-1,-1),'TOP'),
        ]))
        return table

    # ── Table parser ──
    def parse_table(self, lines):
        rows = []
        for l in lines:
            l = l.strip().strip('|')
            rows.append([c.strip() for c in l.split('|')])
        if len(rows) < 2: return None
        header = rows[0]
        data = [r for r in rows[1:] if not all(set(c.strip()) <= set('-: ') for c in r)]
        if not data: return None
        nc = len(header)
        ST = self.ST
        td = [[Paragraph(md_inline(h, self.accent_hex), ST['th']) for h in header]]
        for r in data:
            while len(r) < nc: r.append("")
            td.append([Paragraph(md_inline(c, self.accent_hex), ST['tc']) for c in r[:nc]])
        avail = self.body_w - 4*mm
        max_lens = [max((len(r[ci]) if ci < len(r) else 0) for r in [header]+data) for ci in range(nc)]
        max_lens = [max(m, 2) for m in max_lens]
        total = sum(max_lens)
        cw = [avail * m / total for m in max_lens]
        min_w = 18*mm
        for ci in range(nc):
            if cw[ci] < min_w:
                deficit = min_w - cw[ci]; cw[ci] = min_w
                widest = sorted(range(nc), key=lambda x: -cw[x])
                for oi in widest:
                    if oi != ci: cw[oi] -= deficit; break
        T = self.T
        t = Table(td, colWidths=cw, repeatRows=1)
        t.setStyle(TableStyle([
            ('BACKGROUND',(0,0),(-1,0), T["accent"]),
            ('TEXTCOLOR',(0,0),(-1,0), white),
            ('ROWBACKGROUNDS',(0,1),(-1,-1), [white, T["canvas_sec"]]),
            ('GRID',(0,0),(-1,-1), 0.5, T["border"]),
            ('VALIGN',(0,0),(-1,-1),'TOP'),
            ('LEFTPADDING',(0,0),(-1,-1),5),('RIGHTPADDING',(0,0),(-1,-1),5),
            ('TOPPADDING',(0,0),(-1,-1),3),('BOTTOMPADDING',(0,0),(-1,-1),3),
        ]))
        return t

    # ── Markdown → Story ──
    @staticmethod
    def _preprocess_md(md):
        """Normalize markdown: split merged headings like '# Part## Chapter'."""
        lines = md.split('\n')
        out = []
        in_code = False
        for line in lines:
            if line.strip().startswith('```'):
                in_code = not in_code
            if in_code:
                out.append(line); continue
            # Split where a non-# char is followed by ## (heading marker)
            # e.g. "# 第一部分：背景与概览## 第1章" or "---## 第2章"
            parts = re.split(r'(?<=[^#\s])\s*(?=#{1,3}\s)', line)
            if len(parts) > 1:
                for p in parts:
                    p = p.strip()
                    if p:
                        out.append(p)
            else:
                out.append(line)
        return '\n'.join(out)

    def parse_md(self, md):
        story, toc = [], []
        md = self._preprocess_md(md)
        lines = md.split('\n')
        i, in_code, code_buf = 0, False, []
        ST = self.ST; ah = self.accent_hex
        code_max = self.cfg.get("code_max_lines", 30)

        while i < len(lines):
            line = lines[i]; stripped = line.strip()
            # Code blocks
            if stripped.startswith('```'):
                if in_code:
                    ct = '\n'.join(code_buf)
                    if ct.strip():
                        cl = ct.split('\n')
                        if len(cl) > code_max:
                            cl = cl[:code_max - 2] + ['  // ... (truncated)']
                            ct = '\n'.join(cl)
                        para = Paragraph(_font_wrap(esc_code(ct)), ST['code'])
                        if self._code_style_type == "border":
                            story.append(LeftBorderParagraph(para, self.T["accent"]))
                        else:
                            story.append(para)
                    code_buf = []; in_code = False
                else: in_code = True; code_buf = []
                i += 1; continue
            if in_code: code_buf.append(line); i += 1; continue
            if stripped in ('---','\\newpage','') or stripped.startswith(('title:','subtitle:','author:','date:')):
                i += 1; continue

            # Display math: $$ ... $$ or \[ ... \]
            if stripped.startswith("$$") or stripped.startswith("\\["):
                expr, i = self._consume_math_block(lines, i)
                story.append(Spacer(1, 2*mm))
                story.append(self._math_flowable(expr))
                story.append(Spacer(1, 2*mm))
                continue

            # H1 — Part heading: full divider page
            if re.match(r'^# (第.+部分|附录)', stripped) or \
               (re.match(r'^# .+', stripped) and not stripped.startswith('## ')):
                if re.match(r'^# .+', stripped):
                    title = stripped.lstrip('#').strip()
                    story.append(PageBreak())
                    cm = ChapterMark(title, level=0); story.append(cm)
                    hdeco = self.L["heading_decoration"]
                    story.append(Spacer(1, self.body_h * 0.35))
                    if hdeco == "rules":
                        story.append(HRuleCentered(self.body_w, 40*mm, 0.8, self.T["accent"]))
                        story.append(Spacer(1, 8*mm))
                    story.append(Paragraph(md_inline(title, ah), ST['part']))
                    if hdeco == "rules":
                        story.append(Spacer(1, 8*mm))
                        story.append(HRuleCentered(self.body_w, 25*mm, 0.8, self.T["accent"]))
                    elif hdeco == "underline":
                        story.append(Spacer(1, 4*mm))
                        story.append(HRule(self.body_w, 1.0, self.T["accent"]))
                    elif hdeco == "dot":
                        story.append(Spacer(1, 6*mm))
                        story.append(ClayDot(self.body_w, self.T["accent"]))
                    # "none" = no decoration
                    toc.append(('part', title, cm.key))
                    i += 1; continue

            # H2 — Chapter heading
            if stripped.startswith('## '):
                title = stripped[3:].strip()
                story.append(PageBreak())
                cm = ChapterMark(title, level=1); story.append(cm)
                hdeco = self.L["heading_decoration"]
                story.append(Spacer(1, 8*mm))
                story.append(Paragraph(md_inline(title, ah), ST['chapter']))
                if hdeco == "rules":
                    story.append(Spacer(1, 5*mm))
                    story.append(HRuleCentered(self.body_w, 35*mm, 1.2, self.T["accent"]))
                elif hdeco == "underline":
                    story.append(Spacer(1, 3*mm))
                    story.append(HRule(self.body_w, 0.8, self.T["accent"]))
                elif hdeco == "dot":
                    story.append(Spacer(1, 5*mm))
                    story.append(ClayDot(self.body_w, self.T["accent"]))
                toc.append(('chapter', title, cm.key))
                i += 1; continue

            # H3 = Section
            if stripped.startswith('### '):
                story.append(Spacer(1, 3*mm))
                story.append(Paragraph(md_inline(stripped[4:].strip(), ah), ST['h3']))
                story.append(Spacer(1, 1*mm))
                i += 1; continue

            # H4-H6 = compact sub-sections. This also prevents unknown heading loops.
            hm = re.match(r'^(#{4,6})\s+(.+)', stripped)
            if hm:
                style = ST['h4'] if len(hm.group(1)) == 4 else ST['h5']
                story.append(Paragraph(md_inline(hm.group(2).strip(), ah), style))
                i += 1; continue

            # Standalone or inline markdown images
            if _MD_IMAGE_RE.search(stripped):
                self._append_image_line(story, stripped)
                i += 1; continue

            # Tables
            if stripped.startswith('|'):
                tl = []
                while i < len(lines) and lines[i].strip().startswith('|'):
                    tl.append(lines[i]); i += 1
                t = self.parse_table(tl)
                if t: story.append(Spacer(1,2*mm)); story.append(t); story.append(Spacer(1,2*mm))
                continue

            # Bullets
            if stripped.startswith('- ') or stripped.startswith('* '):
                story.append(Paragraph(f"\u2022  {md_inline(stripped[2:].strip(), ah)}", ST['bullet']))
                i += 1; continue

            # Numbered list
            m = re.match(r'^(\d+)\.\s+(.+)', stripped)
            if m:
                story.append(Paragraph(f"{m.group(1)}.  {md_inline(m.group(2), ah)}", ST['bullet']))
                i += 1; continue

            # Obsidian callouts: > [!NOTE] Optional title
            if re.match(r'^>\s*\[![A-Za-z]+\][+-]?', stripped):
                callout, i = self._consume_callout(lines, i)
                if callout:
                    story.append(Spacer(1, 2*mm))
                    story.append(callout)
                    story.append(Spacer(1, 2*mm))
                    continue

            # Blockquote
            if stripped.startswith('> '):
                story.append(Paragraph(md_inline(stripped[2:].strip(), ah), ST['body_indent']))
                i += 1; continue

            # Paragraph — join consecutive lines; skip space between CJK characters
            plines = []
            while i < len(lines):
                l = lines[i].strip()
                if not l or l.startswith('#') or l.startswith('```') or l.startswith('|') or \
                   l.startswith('- ') or l.startswith('* ') or l.startswith('> ') or \
                   l.startswith("$$") or l.startswith("\\[") or _MD_IMAGE_RE.search(l) or \
                   re.match(r'^\d+\.\s', l):
                    break
                plines.append(l); i += 1
            if plines:
                merged = plines[0]
                for pl in plines[1:]:
                    # If prev line ends with CJK and next starts with CJK, join directly (no space)
                    if merged and pl and _is_cjk(merged[-1]) and _is_cjk(pl[0]):
                        merged += pl
                    else:
                        merged += ' ' + pl
                story.append(Paragraph(md_inline(merged, ah), ST['body']))
            else:
                i += 1
            continue

        return story, toc

    def build_toc(self, toc):
        ST = self.ST; ah = self.accent_hex; ink = self.T["ink"]
        s = [Spacer(1, 15*mm)]
        s.append(Paragraph(md_inline("\u76ee    \u5f55", ah), ST['part']))
        s.append(HRule(self.body_w * 0.12, 1, self.T["accent"]))
        s.append(Spacer(1, 8*mm))
        ink_hex = f"#{int(ink.red*255):02x}{int(ink.green*255):02x}{int(ink.blue*255):02x}" if hasattr(ink,'red') else "#181818"
        for etype, title, key in toc:
            style = ST['toc1'] if etype == 'part' else ST['toc2']
            linked = f"<a href=\"#{key}\" color=\"{ink_hex}\">{_font_wrap(esc(title))}</a>"
            s.append(Paragraph(linked, style))
        return s

    # ── Build PDF ──
    def build(self, md_text, output_path):
        register_fonts()
        print("Parsing markdown...")
        story_content, toc = self.parse_md(md_text)
        print(f"  {len(story_content)} elements, {len(toc)} TOC entries")

        body_frame = Frame(self.lm, self.bm, self.body_w, self.body_h, id='body')
        full_frame = Frame(0, 0, self.page_w, self.page_h, leftPadding=0,
                           rightPadding=0, topPadding=0, bottomPadding=0, id='full')

        doc = BaseDocTemplate(output_path, pagesize=(self.page_w, self.page_h),
                              leftMargin=self.lm, rightMargin=self.rm,
                              topMargin=self.tm, bottomMargin=self.bm,
                              title=self.cfg.get("title", ""),
                              author=self.cfg.get("author", ""))

        templates = [
            PageTemplate(id='normal', frames=[body_frame], onPage=self._normal_page),
        ]

        story = []
        has_frontis = self.cfg.get("frontispiece") and os.path.exists(self.cfg["frontispiece"])
        has_banner = self.cfg.get("banner") and os.path.exists(self.cfg["banner"])
        has_toc = self.cfg.get("toc", True) and toc

        # Cover page
        if self.cfg.get("cover", True):
            templates.insert(0, PageTemplate(id='cover', frames=[full_frame], onPage=self._cover_page))
            story.append(Spacer(1, self.page_h))

            # Determine next page after cover
            if has_frontis:
                templates.append(PageTemplate(id='frontis', frames=[full_frame], onPage=self._frontispiece_page))
                story.append(NextPageTemplate('frontis'))
                story.append(PageBreak())
                story.append(Spacer(1, self.page_h))
                # After frontispiece, go to toc or normal
                if has_toc:
                    templates.append(PageTemplate(id='toc', frames=[body_frame], onPage=self._toc_page))
                    story.append(NextPageTemplate('toc'))
                else:
                    story.append(NextPageTemplate('normal'))
                story.append(PageBreak())
            elif has_toc:
                templates.append(PageTemplate(id='toc', frames=[body_frame], onPage=self._toc_page))
                story.append(NextPageTemplate('toc'))
                story.append(PageBreak())
            else:
                story.append(NextPageTemplate('normal'))
                story.append(PageBreak())
        elif has_toc:
            templates.append(PageTemplate(id='toc', frames=[body_frame], onPage=self._toc_page))
            story.append(NextPageTemplate('toc'))

        # TOC
        if has_toc:
            story.extend(self.build_toc(toc))
            story.append(NextPageTemplate('normal'))
            story.append(PageBreak())

        # If a cover is present, avoid rendering a duplicate H1 divider page.
        # Keep the zero-height ChapterMark so TOC anchors remain valid.
        if self.cfg.get("cover", True):
            while story_content and isinstance(story_content[0], (PageBreak, Spacer)):
                story_content.pop(0)
            if story_content and isinstance(story_content[0], ChapterMark) and story_content[0].level == 0:
                idx = 1
                visual_types = (Spacer, HRule, HRuleCentered, ClayDot)
                while idx < len(story_content):
                    item = story_content[idx]
                    if isinstance(item, visual_types):
                        story_content.pop(idx)
                        continue
                    if isinstance(item, Paragraph) and getattr(item.style, "name", "") == "Part":
                        story_content.pop(idx)
                        continue
                    break
                if idx < len(story_content) - 1 and isinstance(story_content[idx], PageBreak) and \
                   isinstance(story_content[idx + 1], ChapterMark):
                    story_content.pop(idx)
        else:
            while story_content and isinstance(story_content[0], (PageBreak, Spacer)):
                if isinstance(story_content[0], PageBreak):
                    story_content.pop(0)
                    break
                story_content.pop(0)

        story.extend(story_content)

        # Back cover
        if has_banner:
            templates.append(PageTemplate(id='backcover', frames=[full_frame], onPage=self._backcover_page))
            story.append(NextPageTemplate('backcover'))
            story.append(PageBreak())
            story.append(Spacer(1, 1))

        doc.addPageTemplates(templates)
        print("Building PDF...")
        doc.build(story)
        size = os.path.getsize(output_path)
        print(f"Done! {output_path} ({size/1024/1024:.1f} MB)")

# ═══════════════════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════════════════
def parse_frontmatter(md_text):
    """Return (frontmatter, markdown_without_frontmatter). Simple key: value parser."""
    fm_match = re.match(r'^---\s*\n(.*?)\n---\s*(?:\n|$)', md_text, re.DOTALL)
    if not fm_match:
        return {}, md_text
    frontmatter = {}
    for line in fm_match.group(1).splitlines():
        if not line.strip() or line.lstrip().startswith("#") or ":" not in line:
            continue
        key, _, value = line.partition(":")
        value = value.strip()
        if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
            value = value[1:-1]
        frontmatter[key.strip()] = value
    return frontmatter, md_text[fm_match.end():]

def fm_get(frontmatter, *keys, default=""):
    for key in keys:
        if key in frontmatter:
            return frontmatter[key]
    return default

def parse_bool(value, default=True):
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() not in ("0", "false", "no", "off")

def parse_int(value, default):
    if value is None or value == "":
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default

def main():
    parser = argparse.ArgumentParser(description="md2pdf \u2014 Markdown to Professional PDF")
    parser.add_argument("--input", "-i", required=True, help="Input markdown file")
    parser.add_argument("--output", "-o", default="output.pdf", help="Output PDF path")
    parser.add_argument("--title", default=None, help="Cover page title")
    parser.add_argument("--subtitle", default=None, help="Cover page subtitle")
    parser.add_argument("--author", default=None, help="Author name")
    parser.add_argument("--date", default=None, help="Date string")
    parser.add_argument("--version", default=None, help="Version string on cover")
    parser.add_argument("--watermark", default=None, help="Watermark text (empty = none)")
    parser.add_argument("--theme", default=None, help="Theme name")
    parser.add_argument("--theme-file", default=None, help="Custom theme JSON file path")
    parser.add_argument("--cover", default=None, type=lambda x: x.lower() != 'false', help="Generate cover page")
    parser.add_argument("--toc", default=None, type=lambda x: x.lower() != 'false', help="Generate TOC")
    parser.add_argument("--page-size", default=None, choices=["A4","Letter"], help="Page size")
    parser.add_argument("--frontispiece", default=None, help="Path to full-page image after cover")
    parser.add_argument("--banner", default=None, help="Path to back cover banner image")
    parser.add_argument("--header-title", default=None, help="Report title shown in page header (left)")
    parser.add_argument("--footer-left", default=None, help="Brand/author text in footer (left)")
    parser.add_argument("--stats-line", default=None, help="Stats line on cover (e.g. '1,884 files ...')")
    parser.add_argument("--stats-line2", default=None, help="Second stats line on cover")
    parser.add_argument("--edition-line", default=None, help="Edition line at cover bottom")
    parser.add_argument("--disclaimer", default=None, help="Back cover disclaimer text")
    parser.add_argument("--copyright", default=None, help="Back cover copyright text")
    parser.add_argument("--code-max-lines", default=None, type=int, help="Max lines per code block before truncation")
    args = parser.parse_args()

    with open(args.input, encoding='utf-8') as f:
        md_text = f.read()

    frontmatter, md_text = parse_frontmatter(md_text)

    # Extract title from CLI, frontmatter, or first H1.
    title = args.title or fm_get(frontmatter, "title")
    if not title:
        m = re.search(r'^# (.+)$', md_text, re.MULTILINE)
        title = m.group(1).strip() if m else "Document"

    theme_name = args.theme or fm_get(frontmatter, "theme", default="warm-academic")
    theme = load_theme(theme_name, args.theme_file)
    a = theme['accent']
    accent_hex = f"#{int(a.red*255):02x}{int(a.green*255):02x}{int(a.blue*255):02x}" \
        if hasattr(a, 'red') else "#CC785C"
    page_size = args.page_size or fm_get(frontmatter, "page-size", "page_size", default="A4")
    author = args.author or fm_get(frontmatter, "author")

    config = {
        "title": title,
        "subtitle": args.subtitle or fm_get(frontmatter, "subtitle"),
        "author": author,
        "date": args.date or fm_get(frontmatter, "date", default=str(date.today())),
        "version": args.version or fm_get(frontmatter, "version"),
        "watermark": args.watermark or fm_get(frontmatter, "watermark"),
        "theme": theme,
        "accent_hex": accent_hex,
        "cover": args.cover if args.cover is not None else parse_bool(fm_get(frontmatter, "cover"), True),
        "toc": args.toc if args.toc is not None else parse_bool(fm_get(frontmatter, "toc"), True),
        "page_size": A4 if page_size == "A4" else LETTER,
        "frontispiece": args.frontispiece or fm_get(frontmatter, "frontispiece"),
        "banner": args.banner or fm_get(frontmatter, "banner"),
        "header_title": args.header_title or fm_get(frontmatter, "header-title", "header_title"),
        "footer_left": args.footer_left or fm_get(frontmatter, "footer-left", "footer_left") or author,
        "stats_line": args.stats_line or fm_get(frontmatter, "stats-line", "stats_line"),
        "stats_line2": args.stats_line2 or fm_get(frontmatter, "stats-line2", "stats_line2"),
        "edition_line": args.edition_line or fm_get(frontmatter, "edition-line", "edition_line"),
        "disclaimer": args.disclaimer or fm_get(frontmatter, "disclaimer"),
        "copyright": args.copyright or fm_get(frontmatter, "copyright"),
        "code_max_lines": args.code_max_lines if args.code_max_lines is not None else parse_int(fm_get(frontmatter, "code-max-lines", "code_max_lines"), 30),
        "input_dir": os.path.dirname(os.path.abspath(args.input)) or os.getcwd(),
    }

    builder = PDFBuilder(config)
    builder.build(md_text, args.output)

if __name__ == "__main__":
    main()
