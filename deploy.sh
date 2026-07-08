#!/usr/bin/env bash
# jianji 剪辑服务一键部署（Ubuntu）。 sudo bash deploy.sh
set -euo pipefail
APP_DIR=/opt/jianji; ENV_FILE=/etc/jianji.env; SVC_USER=jianji; PORT=3001
REPO=https://github.com/a0916w/jianji.git
[ "$(id -u)" -eq 0 ] || { echo "用 root 跑"; exit 1; }
apt-get update -y && apt-get install -y ffmpeg nodejs npm git python3 make g++
id -u "$SVC_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
if [ -d "$APP_DIR/.git" ]; then git -C "$APP_DIR" pull --ff-only; else git clone "$REPO" "$APP_DIR"; fi
( cd "$APP_DIR" && npm install --omit=dev )   # better-sqlite3(预编译二进制,无则本地编译)
install -d -o "$SVC_USER" -g "$SVC_USER" "$APP_DIR/work"
chown -R "$SVC_USER":"$SVC_USER" "$APP_DIR"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<'EOF'
EDIT_MODE=manual
PORT=3001
EDIT_URL=http://18.163.100.253:3001
SIGN_SECRET=改成一段随机字符串
TELEGRAM_BOT_TOKEN=BotFather给的token
TG_RESULT_CHAT=
WORK_DIR=/opt/jianji/work
DB_PATH=/opt/jianji/work/jobs.sqlite
DEFAULT_IMAGE_DUR=3
DEFAULT_SEG_LEN=5
DEFAULT_FADE=0.35
DEFAULT_ASPECT=auto
EOF
  chmod 600 "$ENV_FILE"; echo ">>> 生成 $ENV_FILE，填好 SIGN_SECRET/TELEGRAM_BOT_TOKEN 后重跑"; exit 0
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
