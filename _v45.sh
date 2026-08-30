#!/bin/bash
echo "== download #45 screenshot =="
curl -sL -o /tmp/i45.jpg "https://github.com/user-attachments/assets/266184eb-14d9-4500-ae92-5b620edc17ff" -w 'download=%{http_code} type=%{content_type} bytes=%{size_download}\n'
echo "== check #45 screenshot is a valid image (magic bytes) =="
head -c 12 /tmp/i45.jpg | xxd | head -1
echo "== deployed web bundle: simplified marker =="
docker exec apertureprism-ai-review-web-1 sh -c 'cd /usr/share/nginx/html && f=$(ls assets/*.js 2>/dev/null | head -1); echo "bundle=$f"; grep -c "仓库级可覆盖的项请在「已安装仓库」" "$f" 2>/dev/null || echo 0'
echo "== old-page keys currently in bundle (should relate to ReposPage) =="
docker exec apertureprism-ai-review-web-1 sh -c 'cd /usr/share/nginx/html && f=$(ls assets/*.js 2>/dev/null | head -1); grep -o "issue_auto_assign" "$f" 2>/dev/null | head -1'