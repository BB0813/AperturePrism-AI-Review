#!/bin/bash
W() { docker exec apertureprism-ai-review-web-1 sh -c "cd /usr/share/nginx/html; ls -la assets/*.js; echo --; wc -c assets/*.js; echo --; head -c 200 assets/*.js"; }
W | head -30
echo "== grep known strings =="
docker exec apertureprism-ai-review-web-1 sh -c 'cd /usr/share/nginx/html; echo "已安装仓库: $(grep -o "已安装仓库" assets/*.js | head -1)"; echo "GitHub 接入: $(grep -o "GitHub 接入" assets/*.js | head -1)"'
echo "== index.html asset ref =="
docker exec apertureprism-ai-review-web-1 sh -c 'grep -oE "assets/[^"]+\.(js|css)" /usr/share/nginx/html/index.html'