#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
env_file="$project_dir/.env"
if [ -e "$env_file" ]; then
    printf '配置文件已存在，未覆盖：%s\n' "$env_file"
    exit 0
fi

umask 077
temp_file=$(mktemp "$project_dir/.env.XXXXXXXX")
trap 'rm -f "$temp_file"' 0 HUP INT TERM
random_hex() {
    od -An -N "$1" -tx1 /dev/urandom | tr -d ' \n'
}

cat > "$temp_file" <<EOF
DB_PASSWORD=$(random_hex 32)
SESSION_SECRET=$(random_hex 48)
ADMIN_PASSWORD=$(random_hex 24)
PUBLIC_ORIGIN=http://localhost:8080
COOKIE_SECURE=false
WEB_PORT=8080
EOF
if ! ln "$temp_file" "$env_file" 2>/dev/null; then
    printf '配置文件在生成期间已创建，未覆盖：%s\n' "$env_file" >&2
    exit 1
fi
rm -f "$temp_file"
trap - 0 HUP INT TERM
printf '已创建私有配置：%s；请妥善保存管理员密码。\n' "$env_file"
