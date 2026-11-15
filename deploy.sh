#!/bin/bash
# yatterra 仓库部署入口（平台 Pod 部署页 → 来源=绑仓库）。
#
# 代码来自本目录（本目录是 pod 内 git clone 的结果，如 ~/deploy/fancyu），
# 而**运行态数据与凭据仍留在既有目录 /home/cloud/sysudate**（不入库的东西）：
#   .private/          admin-ai.json / pay.json / mail.env / chat-review.jsonl / weekly-venv
#   web/photos/        历史用户照片（.gitignore 排除，共 573M）
#   api/node_modules/  依赖（.gitignore 排除，复用既有安装，不重新 npm install）
# 上面三项在 clone 里做软链补齐，避免部署后丢数据/丢依赖。
#
# 凭据（MYSQL_*/JWT_SECRET/ADMIN_PASSWORD/SMTP_*）由平台以环境变量注入
# （deploy 记录的 env）；下面的 .private/mail.env 只是 env 缺失时的兜底。
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
LIVE="${SYSUDATE_LIVE_DIR:-/home/cloud/sysudate}"

# node_modules 属主自愈(曾被 root 污染会致 cloud 读不到)
if find "$LIVE/api/node_modules" -maxdepth 3 ! -user cloud 2>/dev/null | grep -q .; then
    sudo -n chown -R cloud:cloud "$LIVE/api/node_modules" 2>/dev/null || true
fi

link() {  # link <相对路径>: clone 内缺就用既有目录补齐(幂等)
    local rel="$1" src="$LIVE/$1" dst="$APP_DIR/$1"
    [ -e "$src" ] || return 0
    if [ ! -e "$dst" ] && [ ! -L "$dst" ]; then
        mkdir -p "$(dirname "$dst")"
        ln -s "$src" "$dst"
    fi
}

link api/node_modules
link .private
link web/photos

export PORT="${PORT:-8080}"
export WEB_DIR="${WEB_DIR:-$APP_DIR/web}"
export WEEKLY_PYTHON="${WEEKLY_PYTHON:-$LIVE/.private/weekly-venv/bin/python}"

# SMTP 凭据兜底: 平台 env 没给就读既有 .private/mail.env(值相同)
if [ -z "${SMTP_PASSWORD:-}" ] && [ -f "$LIVE/.private/mail.env" ]; then
    . "$LIVE/.private/mail.env"
fi

cd "$APP_DIR/api"
exec /usr/bin/node index.js
