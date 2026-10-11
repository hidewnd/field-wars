#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
    printf '用法：%s 备份文件.dump\n' "$0" >&2
    exit 2
fi
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
target=$1
if [ -e "$target" ]; then
    printf '目标文件已存在，未覆盖：%s\n' "$target" >&2
    exit 1
fi
target_dir=$(dirname -- "$target")
if [ ! -d "$target_dir" ]; then
    printf '目标目录不存在：%s\n' "$target_dir" >&2
    exit 1
fi
target_dir=$(CDPATH= cd -- "$target_dir" && pwd)
target="$target_dir/$(basename -- "$target")"
umask 077
temp_file=$(mktemp "$target_dir/.game-backup.XXXXXXXX")
trap 'rm -f "$temp_file"' 0 HUP INT TERM
cd "$project_dir"
docker compose exec -T db pg_dump -U game -d game --format=custom --no-owner --no-acl > "$temp_file"
docker compose exec -T db pg_restore --list < "$temp_file" > /dev/null
if ! ln "$temp_file" "$target" 2>/dev/null; then
    printf '目标文件在备份期间已创建，未覆盖：%s\n' "$target" >&2
    exit 1
fi
rm -f "$temp_file"
trap - 0 HUP INT TERM
printf '备份已完成：%s\n' "$target"
