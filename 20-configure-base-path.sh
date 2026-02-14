#!/bin/sh
set -e

raw="${BASE_PATH:-/}"
BASE_PATH=$(echo "$raw" | sed 's|/*$||; s|^/*|/|')

if [ "$BASE_PATH" = "/" ]; then
    LOCATION_PATH="/"
    BASE_HREF="/"
    TRY_FALLBACK="/index.html"
    REDIRECT_BLOCK="# root deployment - no redirect needed"
else
    LOCATION_PATH="${BASE_PATH}/"
    BASE_HREF="${BASE_PATH}/"
    TRY_FALLBACK="${BASE_PATH}/index.html"
    REDIRECT_BLOCK="location = ${BASE_PATH} { return 301 ${BASE_PATH}/; }"
fi

echo "[base-path] BASE_PATH=${BASE_PATH}"
echo "[base-path] BASE_HREF=${BASE_HREF}"

# ── 1. Generate nginx config ──
cat > /etc/nginx/conf.d/default.conf <<ENDOFCONF
server {
    listen 8000;
    server_name _;

    gzip on;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml text/markdown;
    gzip_min_length 256;
    gzip_vary on;

    location ${LOCATION_PATH}vendor/ {
        alias /usr/share/nginx/html/vendor/;
        expires 7d;
        add_header Cache-Control "public, immutable";
        add_header X-Content-Type-Options "nosniff" always;
    }

    # Serve docs as text/markdown (not SPA fallback)
    location ${LOCATION_PATH}docs/ {
        alias /usr/share/nginx/html/docs/;
        default_type text/markdown;
        add_header Cache-Control "no-cache, must-revalidate";
        add_header X-Content-Type-Options "nosniff" always;
    }

    location ${LOCATION_PATH} {
        alias /usr/share/nginx/html/;
        index index.html;
        try_files \$uri \$uri/ ${TRY_FALLBACK};
        expires -1;
        add_header Cache-Control "no-cache, must-revalidate";
        add_header X-Frame-Options "SAMEORIGIN" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
    }

    ${REDIRECT_BLOCK}
}
ENDOFCONF

echo "[base-path] nginx config:"
cat /etc/nginx/conf.d/default.conf

# ── 2. Inject <base href> into index.html ──
sed -i "s|<head>|<head>\n    <base href=\"${BASE_HREF}\">|" /usr/share/nginx/html/index.html

echo "[base-path] Injected <base href=\"${BASE_HREF}\"> into index.html"
