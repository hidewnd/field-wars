#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
    printf '用法：%s 新项目名 备份文件.dump\n' "$0" >&2
    exit 2
fi
project=$1
archive=$2
case "$project" in
    ''|*[!a-z0-9_-]*|-*|_*|[0-9]*)
        printf '项目名必须以小写字母开头，仅含小写字母、数字、下划线或短横线。\n' >&2
        exit 2
        ;;
esac
if [ "$project" = junction-city ]; then
    printf '恢复目标必须是新项目，不能覆盖默认项目。\n' >&2
    exit 2
fi
if [ ! -r "$archive" ]; then
    printf '备份文件不可读：%s\n' "$archive" >&2
    exit 1
fi
archive=$(CDPATH= cd -- "$(dirname -- "$archive")" && pwd)/$(basename -- "$archive")
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"
if docker volume inspect "${project}_pgdata" > /dev/null 2>&1; then
    printf '目标项目数据库卷已存在，拒绝覆盖：%s\n' "$project" >&2
    exit 1
fi
if [ -n "$(docker compose -p "$project" ps --all -q)" ]; then
    printf '目标项目已有容器，拒绝覆盖：%s\n' "$project" >&2
    exit 1
fi
docker compose -p "$project" up -d --wait db
docker compose -p "$project" exec -T db pg_restore -U game -d game --no-owner --exit-on-error < "$archive"
printf '已恢复至独立项目 %s；可用 docker compose -p %s up -d --build 启动服务。\n' "$project" "$project"
