#!/bin/bash
echo "== all js assets =="
docker exec apertureprism-ai-review-web-1 sh -c 'ls -1 /usr/share/nginx/html/assets/*.js' | wc -l
echo "== simplified marker across all js =="
docker exec apertureprism-ai-review-web-1 sh -c 'grep -rl "仓库级可覆盖的项请在" /usr/share/nginx/html/assets/*.js 2>/dev/null | head'
echo "== old-page marker (issue_auto_assign) count =="
docker exec apertureprism-ai-review-web-1 sh -c 'grep -ro "issue_auto_assign" /usr/share/nginx/html/assets/*.js 2>/dev/null | wc -l'
echo "== analysis settings desc markers =="
docker exec apertureprism-ai-review-web-1 sh -c 'grep -ro "仓库级可覆盖项已在「已安装仓库」页设置|这里保留全局不可覆盖项" /usr/share/nginx/html/assets/*.js 2>/dev/null | wc -l'