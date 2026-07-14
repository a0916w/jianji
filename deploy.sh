#!/usr/bin/env bash
# jianji 剪辑服务一键部署（Ubuntu）。 sudo bash deploy.sh
set -euo pipefail
APP_DIR=/opt/jianji; ENV_FILE=/etc/jianji.env; SVC_USER=jianji; PORT=3001
REPO=https://github.com/a0916w/jianji.git
[ "$(id -u)" -eq 0 ] || { echo "用 root 跑"; exit 1; }
apt-get update -y && apt-get install -y ffmpeg nodejs npm git python3 make g++
id -u "$SVC_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
# git/npm 一律以服务账户 $SVC_USER 身份跑：属主自己操作既无 dubious-ownership 报错，
# 也不给 root 信任一个服务账户可写的库（否则被埋 .git/hooks 会以 root 执行 = 提权）。
# $SVC_USER 是 nologin 无家目录账户，显式给 HOME=$APP_DIR 供 git/npm 写配置与缓存。
install -d -o "$SVC_USER" -g "$SVC_USER" "$APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  sudo -u "$SVC_USER" env HOME="$APP_DIR" git -C "$APP_DIR" pull --ff-only
else
  sudo -u "$SVC_USER" env HOME="$APP_DIR" git clone "$REPO" "$APP_DIR"
fi
sudo -u "$SVC_USER" env HOME="$APP_DIR" bash -c 'cd "$1" && npm install --omit=dev' _ "$APP_DIR"
install -d -o "$SVC_USER" -g "$SVC_USER" "$APP_DIR/work"
chown -R "$SVC_USER":"$SVC_USER" "$APP_DIR"
if [ ! -f "$ENV_FILE" ]; then
  # 安全修复：不能用可猜测的占位符当 SIGN_SECRET（用户可能懒得改，直接破坏链接签名防护）。
  # 首次生成时自动出一段强随机密钥；openssl 不存在时退化用 /dev/urandom。
  GEN_SECRET=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  # /jobs 管理列表用 ADMIN_TOKEN 保护，同样自动生成随机值，别留给用户默认放行。
  GEN_ADMIN=$(openssl rand -hex 16 2>/dev/null || head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
  cat > "$ENV_FILE" <<EOF
EDIT_MODE=manual
PORT=3001
EDIT_URL=http://18.163.100.253:3001
SIGN_SECRET=$GEN_SECRET
ADMIN_TOKEN=$GEN_ADMIN
TELEGRAM_BOT_TOKEN=BotFather给的token
TG_RESULT_CHAT=
WORK_DIR=/opt/jianji/work
DB_PATH=/opt/jianji/work/jobs.sqlite
DEFAULT_IMAGE_DUR=3
DEFAULT_SEG_LEN=5
DEFAULT_FADE=0.35
DEFAULT_ASPECT=auto
# ---- 明顺切片（成片切片投放；不填则前端不显示「切片」入口）----
MINGSHUN_ENABLED=false
MINGSHUN_API_URL=
MINGSHUN_USERNAME=
MINGSHUN_RULE=
MINGSHUN_FTP_HOST=
MINGSHUN_FTP_PORT=21
MINGSHUN_FTP_USER=
MINGSHUN_FTP_PASS=
MINGSHUN_TIMEOUT=120
# 可选主题列表（逗号分隔），切片时由用户从中选一个。用干净名（如 abc,def）
MINGSHUN_THEMES=
# 发给明顺时给主题加的前缀（明顺 category 约定，如 media-）。填了则 abc 发送为 media-abc；不填原样发
MINGSHUN_THEME_PREFIX=
EOF
  chmod 600 "$ENV_FILE"; echo ">>> 生成 $ENV_FILE（SIGN_SECRET / ADMIN_TOKEN 已自动生成随机值），填好 TELEGRAM_BOT_TOKEN 后重跑"; exit 0
fi
chmod 600 "$ENV_FILE"
cat > /etc/systemd/system/jianji.service <<EOF
[Unit]
Description=jianji edit service
After=network.target
[Service]
User=$SVC_USER
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) server.js
Restart=always
EnvironmentFile=$ENV_FILE
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now jianji
sleep 1; systemctl --no-pager status jianji | head -5
echo "OK: http://<IP>:$PORT （安全组放行 $PORT；出站放行 FTP/Telegram 无关，需能访问 api.telegram.org）"
