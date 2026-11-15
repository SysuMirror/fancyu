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
#
# 约定：**先检查再启动**。这个脚本是 supervisord 的 program(autostart/autorestart)，
# 任何一步失败都会让 supervisord 重启它；所以「能起来但功能悄悄坏掉」的坑（比如软链
# 没补上、pay.json 没了）必须在这里显式喊出来，否则日志里只会看到 node 的二次报错。
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
LIVE="${SYSUDATE_LIVE_DIR:-/home/cloud/sysudate}"

log() { echo "[deploy $(date '+%F %T')] $*"; }

# 本次部署的 commit 留痕：便于和平台记录里的 last_ref 对照（排查“到底跑的是哪版”）
log "dir=$APP_DIR ref=$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo '?') live=$LIVE"

# 1) 运行态数据目录：不存在不致命，但功能会静默坏掉 —— 显式告警
if [ ! -d "$LIVE/.private" ]; then
    log "警告: $LIVE/.private 不存在 —— 支付/后台数据/邮件凭据会缺失(env 兜底除外)"
fi
[ -f "$LIVE/.private/pay.json" ] || log "警告: $LIVE/.private/pay.json 不存在 —— 支付定价回落环境变量"

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
        log "已软链 $rel -> $src"
    fi
}

link api/node_modules
link .private
link web/photos

# 2) 依赖是硬前提：两边都没有就直接失败。否则 node 会 crash-loop，
#    日志里只有 MODULE_NOT_FOUND，看不出根因是“依赖目录没挂上”。
if [ ! -e "$APP_DIR/api/node_modules" ]; then
    log "错误: 缺少 api/node_modules（$LIVE/api/node_modules 也不存在），无法启动"
    exit 1
fi
[ -e "$APP_DIR/web/index.html" ] || log "警告: $APP_DIR/web/index.html 不存在 —— 静态站点可能 404"

export PORT="${PORT:-8080}"
export WEB_DIR="${WEB_DIR:-$APP_DIR/web}"
export WEEKLY_PYTHON="${WEEKLY_PYTHON:-$LIVE/.private/weekly-venv/bin/python}"

# SMTP 凭据兜底: 平台 env 没给就读既有 .private/mail.env(值相同)
if [ -z "${SMTP_PASSWORD:-}" ] && [ -f "$LIVE/.private/mail.env" ]; then
    . "$LIVE/.private/mail.env"
fi

log "启动 node: PORT=$PORT WEB_DIR=$WEB_DIR 邮件=$([ -n "${SMTP_PASSWORD:-}" ] && echo 已配置 || echo 缺失)"
cd "$APP_DIR/api"
exec /usr/bin/node index.js
