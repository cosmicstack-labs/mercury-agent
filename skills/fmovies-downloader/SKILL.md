---
name: fmovies-downloader
description: Search and download movies from fmovies (ww2-fmovies.com) using yt-dlp. Searches via the site's API, then downloads the best available quality.
---

# fmovies-downloader

Search and download movies from ww2-fmovies.com.

## How it works

1. **Search** — Uses the site's search API (`/ajax/search`) to find movies by title
2. **Get movie page** — Fetches the movie page to extract the embed URL
3. **Resolve embed** — Extracts the actual video source from the embedded player
4. **Download** — Uses yt-dlp to download the movie

## Usage

When the user says something like:
- "Download [movie name] from fmovies"
- "Search for [movie] on fmovies"
- "Get [movie] from ww2-fmovies.com"

## Steps

1. Search for the movie using the API: `POST https://ww2-fmovies.com/ajax/search` with body `keyword=<movie name>`
2. Parse the search results and pick the best match (or ask the user if multiple)
3. Fetch the movie page HTML from the result URL
4. Extract the embed URL (look for an iframe or a redirect to an embed domain like `megacloud`, `upstream`, etc.)
5. Use yt-dlp to extract the direct video URL and download it
6. Report the result to the user

## Notes

- The site uses Gatsby (client-side rendered), so the search API is the reliable way to find content
- Embed sources vary — yt-dlp handles most of them automatically
- Default quality: best available
- Output goes to the user's downloads directory or current working directory
