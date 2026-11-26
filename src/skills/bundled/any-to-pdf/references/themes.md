# Theme Reference

Each theme is a Python dict with these keys. All values are hex color strings.

## Theme Structure

```python
THEME = {
    "canvas":      "#F9F9F7",  # page background
    "canvas_sec":  "#F0EEE6",  # secondary bg (code blocks, alternating rows)
    "ink":         "#181818",  # primary text
    "ink_faded":   "#87867F",  # secondary text (subtitles, captions)
    "accent":      "#CC785C",  # primary accent (headings, rules, table headers)
    "accent_light":"#D99A82",  # lighter accent
    "border":      "#E8E6DC",  # borders, horizontal rules
    "code_bg":     "#F0EEE6",  # code block background (usually = canvas_sec)
    "watermark":   (0.82, 0.80, 0.76, 0.12),  # RGBA tuple for watermark
}
```

## Available Themes

### warm-academic (default)
Warm ivory canvas with terracotta accents. Inspired by academic papers on aged paper.
Best for: Chinese technical reports, research papers, documentation.
```python
{"canvas":"#F9F9F7","canvas_sec":"#F0EEE6","ink":"#181818","ink_faded":"#87867F",
 "accent":"#CC785C","accent_light":"#D99A82","border":"#E8E6DC"}
```

### nord-frost
Cool blue-gray palette from the Nord color scheme.
Best for: Developer documentation, technical specs.
```python
{"canvas":"#ECEFF4","canvas_sec":"#E5E9F0","ink":"#2E3440","ink_faded":"#4C566A",
 "accent":"#5E81AC","accent_light":"#81A1C1","border":"#D8DEE9"}
```

### github-light
Clean white with blue accents, matching GitHub's documentation style.
Best for: Open-source project docs, README-style reports.
```python
{"canvas":"#FFFFFF","canvas_sec":"#F6F8FA","ink":"#1F2328","ink_faded":"#656D76",
 "accent":"#0969DA","accent_light":"#218BFF","border":"#D0D7DE"}
```

### monokai-warm
Dark background with warm accent colors.
Best for: Code-heavy reports, developer presentations.
```python
{"canvas":"#272822","canvas_sec":"#1E1F1C","ink":"#F8F8F2","ink_faded":"#75715E",
 "accent":"#F92672","accent_light":"#FD971F","border":"#49483E"}
```

### solarized-light
Ethan Schoonover's Solarized Light palette.
Best for: Long-form reading, academic papers.
```python
{"canvas":"#FDF6E3","canvas_sec":"#EEE8D5","ink":"#657B83","ink_faded":"#93A1A1",
 "accent":"#CB4B16","accent_light":"#DC322F","border":"#EEE8D5"}
```

### dracula-soft
Softened Dracula theme with muted dark purple background.
Best for: Evening reading, dark-mode preference reports.
```python
{"canvas":"#282A36","canvas_sec":"#21222C","ink":"#F8F8F2","ink_faded":"#6272A4",
 "accent":"#BD93F9","accent_light":"#FF79C6","border":"#44475A"}
```

### paper-classic
Pure white with black text and minimal red accents. Traditional print look.
Best for: Formal documents, print-ready reports, submissions.
```python
{"canvas":"#FFFFFF","canvas_sec":"#FAFAFA","ink":"#000000","ink_faded":"#666666",
 "accent":"#CC0000","accent_light":"#FF3333","border":"#DDDDDD"}
```

### ocean-breeze
Light teal/aqua tones for a fresh, modern feel.
Best for: Product reports, marketing docs, light technical content.
```python
{"canvas":"#F0F7F4","canvas_sec":"#E0EDE8","ink":"#1A2E35","ink_faded":"#5A7D7C",
 "accent":"#2A9D8F","accent_light":"#64CCBF","border":"#C8DDD6"}
```

## Custom Theme

Pass a JSON file path to `--theme-file`:

```json
{
  "canvas": "#FEFEFE",
  "canvas_sec": "#F5F5F5",
  "ink": "#222222",
  "ink_faded": "#888888",
  "accent": "#E74C3C",
  "accent_light": "#F39C12",
  "border": "#DDDDDD"
}
```
