#!/bin/sh
set -e

# ── BASE_PATH normalization ──
# Input: BASE_PATH env var (default: /)
# Output: LOCATION_PATH, TRY_FALLBACK, VENDOR_PATH, REDIRECT_BLOCK
#
# Examples:
#   BASE_PATH=/        → location /          (production)
#   BASE_PATH=/editor  → location /editor/   (sub-path)
#   BASE_PATH=/test    → location /test/     (test env)

raw="${BASE_PATH:-/}"

# Strip trailing slashes, ensure leading slash
BASE_PATH=$(echo "$raw" | sed 's|/*$||; s|^/*|/|')

if [ "$BASE_PATH" = "/" ]; then
    # Root deployment — standard SPA
    export LOCATION_PATH="/"
    export TRY_FALLBACK="/index.html"
    export REDIRECT_BLOCK="# root deployment — no redirect needed"
else
    # Sub-path deployment — alias-based with trailing slash redirect
    export LOCATION_PATH="${BASE_PATH}/"
    export TRY_FALLBACK="${BASE_PATH}/index.html"
    export REDIRECT_BLOCK="location = ${BASE_PATH} { return 301 ${BASE_PATH}/; }"
fi

echo "[entrypoint] BASE_PATH=${BASE_PATH}"
echo "[entrypoint] LOCATION_PATH=${LOCATION_PATH}"

# Generate nginx config from template (only replace our vars, not nginx $uri etc.)
envsubst '${LOCATION_PATH} ${TRY_FALLBACK} ${REDIRECT_BLOCK}' \
    < /etc/nginx/templates/default.conf.template \
    > /etc/nginx/conf.d/default.conf

echo "[entrypoint] nginx config generated:"
cat /etc/nginx/conf.d/default.conf

exec nginx -g 'daemon off;'
