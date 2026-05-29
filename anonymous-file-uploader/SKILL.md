---
name: anonymous-file-uploader
description: Upload files to anonymous file sharing services without registration. Supports tmpfiles.org, 0x0.st, file.io, temp.sh, uguu.se, and more. Handles upload, verification, expiry tracking, and backup mirroring.
---

# Anonymous File Uploader Skill

Upload files to free, no-registration file sharing services. Supports automatic fallback between multiple providers and optional mirroring for redundancy.

## When to Use

- User says "upload this file somewhere and share the link"
- User wants to share a file anonymously
- User says "send this to a temp file host"
- User provides a file path and wants an anonymous download link
- Any request involving: `tmpfiles.org`, `0x0.st`, `file.io`, `temp.sh`, `uguu.se`, `catbox.moe`, `litterbox.catbox.moe`, `anonfiles.com`

## Supported Services

| Service | Max Size | Expiry | Method | Reliability |
|---------|----------|--------|--------|-------------|
| tmpfiles.org | 1GB | ~1 hour (free) | `curl -F "file=@FILE" https://tmpfiles.org/api/v1/upload` | ★★★★☆ |
| 0x0.st | 512MB | 30 days | `curl -F "file=@FILE" https://0x0.st` | ★★★☆☆ (occasional downtime) |
| file.io | 2GB | 1 download or 24h | `curl -F "file=@FILE" https://file.io` | ★★★☆☆ (rate limits) |
| temp.sh | 10GB | 14 days | `curl -F "file=@FILE" https://temp.sh/upload` | ★★★★☆ |
| uguu.se | 8GB | 60 days | `curl -F "files[]=@FILE" https://uguu.se/upload` | ★★★★☆ |
| catbox.moe | 200MB | Permanent | `curl -F "reqtype=fileupload" -F "fileToUpload=@FILE" https://catbox.moe/user/api.php` | ★★★★★ |
| litterbox | 1GB | 24h max | `curl -F "reqtype=fileupload" -F "time=24h" -F "fileToUpload=@FILE" https://litterbox.catbox.moe/resources/internals/api.php` | ★★★★☆ |
| anonfiles.com | 20GB | 30 days | `curl -F "file=@FILE" https://api.anonfiles.com/upload` | ★★★☆☆ (ads) |

## Workflow

### 1. Check File Exists

```bash
ls -lh <filepath>
```

If the file doesn't exist, inform the user and stop.

### 2. Choose Service(s)

**Single upload (default):** Start with `tmpfiles.org` — it's the simplest and most reliable.

```bash
RESPONSE=$(curl -s -F "file=@<filepath>" https://tmpfiles.org/api/v1/upload)
echo "$RESPONSE"
```

Extract the download URL:
```bash
DOWNLOAD_URL=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['url'])")
```

**Fallback chain** (if tmpfiles.org fails):
1. Try `catbox.moe` (permanent, very reliable)
2. Try `uguu.se` (generous limits, 60 days)
3. Try `temp.sh` (10GB, 14 days)

### 3. Verify Upload

After uploading, verify the download URL is accessible:

```bash
curl -s -o /dev/null -w "%{http_code}" "<DOWNLOAD_URL>"
```

Should return `200`. If not, try the next service in the fallback chain.

### 4. Report Results

Present to the user:

```
✅ File uploaded successfully!
📎 Download: <URL>
⏱ Expiry: <expiry info>
📦 Size: <human-readable size>
🔄 Service: <service name>

Mirror (optional): <backup URL>
```

### 5. Mirroring (Optional)

For important files, offer to upload to a second service as a backup:

```
curl -F "file=@<filepath>" https://<BACKUP_SERVICE_URL>
```

### Mirror Upload Commands

**Catbox (permanent):**
```bash
curl -s -F "reqtype=fileupload" -F "fileToUpload=@<filepath>" https://catbox.moe/user/api.php
```

**Uguu (60 days):**
```bash
curl -s -F "files[]=@<filepath>" https://uguu.se/upload
```

**Temp.sh (14 days):**
```bash
curl -s -F "file=@<filepath>" https://temp.sh/upload
```

## Common Issues & Solutions

### "File not found" error
- Check the path exists with `ls -lh <path>`
- Expand `~` to the full home directory path
- The file might have been deleted since creation

### Upload returns empty response
- File might be too large for the service
- Try a different service with higher limits
- Check internet connectivity

### tmpfiles.org returns error
- Service is rate-limited or temporarily down
- Fall back to catbox.moe or uguu.se immediately

### File contains special characters
- curl handles this fine with `-F "file=@FILE"` syntax
- Spaces in filenames work without quoting issues

## Tips

- **Larger files** (>100MB): Use temp.sh (10GB limit, 14 days)
- **Permanent hosting** (<200MB): Use catbox.moe
- **Quick share** (<1GB): Use tmpfiles.org
- **Self-destructing** (1 download): Use file.io
- **Temporary** (<24h): Use litterbox.catbox.moe

## Response Template

When delivering the link to the user, format it cleanly:

```
📎 **<filename>** uploaded to <service>

🔗 <download_url>
⏳ Expires: <expiry_info>
📦 <size> | 🛡️ No registration required

<optional: mirror info>
```

## Dependencies

- `curl` (pre-installed on macOS/Linux)
- No API keys, no accounts, no registration needed
