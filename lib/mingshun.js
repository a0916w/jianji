// lib/mingshun.js —— 明顺切片对接：把成片 out.mp4 经 FTP 传到明顺，再 POST 明顺转码 API
// 触发切片（明顺侧按 rule 切片、按 theme 归类）。协议照搬 crawler 的 storage/mingshun.py：
//   1) FTP STOR <uid>.mp4 到 /<username>/ 目录
//   2) POST MINGSHUN_API_URL  {title,description,image,video,md5,username,rule,theme:[..]}
//      返回 {code:1, data:{video_id}} 视为成功。
// 本项目刻意零第三方依赖（只有 better-sqlite3），FTP 客户端用 net 手写被动模式 STOR。
const net = require('net');
const fs = require('fs');
const crypto = require('crypto');
const { httpPostJson } = require('./util');

// 从环境变量读取配置。账号 / 规则 / FTP 固定在 .env；主题给一个可选列表，切片时由用户选一个。
function cfg() {
  const e = process.env;
  return {
    enabled: String(e.MINGSHUN_ENABLED || '').toLowerCase() === 'true',
    apiUrl: e.MINGSHUN_API_URL || '',
    username: e.MINGSHUN_USERNAME || '',
    rule: e.MINGSHUN_RULE || '',
    ftpHost: e.MINGSHUN_FTP_HOST || '',
    ftpPort: parseInt(e.MINGSHUN_FTP_PORT || '21', 10),
    ftpUser: e.MINGSHUN_FTP_USER || '',
    ftpPass: e.MINGSHUN_FTP_PASS || '',
    timeoutMs: parseInt(e.MINGSHUN_TIMEOUT || '120', 10) * 1000,
    themes: String(e.MINGSHUN_THEMES || '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}

// 六项 FTP/API 必填齐了才算配置完整（与 python 版 MingshunSettings.configured 一致）。
function configured(c) {
  c = c || cfg();
  return !!(c.apiUrl && c.username && c.rule && c.ftpHost && c.ftpUser && c.ftpPass);
}

// 对外暴露给前端的切片信息：是否可用 + 可选主题列表（不含任何密钥）。
function sliceInfo() {
  const c = cfg();
  return { enabled: c.enabled && configured(c), themes: c.themes };
}

// 解析一条完整 FTP 应答（支持多行 "227-...\r\n227 ..."），返回 {code,text} 或 null（未读完）。
// 消费掉 buffer 里已完整的那条，剩余留在 ref.buf。
function parseReply(ref) {
  const nl = '\r\n';
  const lines = ref.buf.split(nl);
  if (lines.length < 2) return null; // 至少要有一条以 \r\n 结尾的完整行
  const m = /^(\d{3})([ -])/.exec(lines[0]);
  if (!m) { ref.buf = lines.slice(1).join(nl); return null; } // 丢弃畸形行
  const code = m[1];
  if (m[2] === ' ') { ref.buf = lines.slice(1).join(nl); return { code: parseInt(code, 10), text: lines[0] }; }
  // 多行：以 "code " 结尾行终止
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].startsWith(code + ' ')) {
      ref.buf = lines.slice(i + 1).join(nl);
      return { code: parseInt(code, 10), text: lines.slice(0, i + 1).join('\n') };
    }
  }
  return null;
}

// 被动模式把 localPath 以 remoteName STOR 到当前登录用户目录。纯 net，无第三方依赖。
function ftpStore(c, remoteName, localPath) {
  return new Promise((resolve, reject) => {
    const ctrl = net.createConnection({ host: c.ftpHost, port: c.ftpPort });
    ctrl.setEncoding('utf8'); // 控制连接是文本；数据连接另开、走二进制
    ctrl.setTimeout(c.timeoutMs);
    const ref = { buf: '' };
    let waiter = null;
    let settled = false;

    const finish = (err, val) => {
      if (settled) return; settled = true;
      try { ctrl.destroy(); } catch (_) {}
      if (err) reject(err instanceof Error ? err : new Error('FTP: ' + err));
      else resolve(val);
    };
    const pump = () => {
      if (!waiter) return;
      const r = parseReply(ref);
      if (r) { const w = waiter; waiter = null; w(r); }
    };
    const expect = () => new Promise((res) => { waiter = res; pump(); });

    ctrl.on('data', (chunk) => { ref.buf += chunk; pump(); });
    ctrl.on('error', (e) => finish(e));
    ctrl.on('timeout', () => finish('控制连接超时'));
    ctrl.on('close', () => { if (!settled) finish('控制连接被关闭'); });

    (async () => {
      try {
        let r = await expect();                       // 220 欢迎
        if (Math.floor(r.code / 100) !== 2) throw new Error('FTP 欢迎异常: ' + r.text);
        ctrl.write(`USER ${c.ftpUser}\r\n`);
        r = await expect();                           // 331 需要密码 / 230 直接登录
        if (r.code === 331) { ctrl.write(`PASS ${c.ftpPass}\r\n`); r = await expect(); }
        if (r.code !== 230) throw new Error('FTP 登录失败: ' + r.text);
        ctrl.write('TYPE I\r\n');
        r = await expect();                           // 200 二进制模式
        if (r.code !== 200) throw new Error('FTP TYPE I 失败: ' + r.text);
        ctrl.write('PASV\r\n');
        r = await expect();                           // 227 (h1,h2,h3,h4,p1,p2)
        if (r.code !== 227) throw new Error('FTP PASV 失败: ' + r.text);
        const pm = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(r.text);
        if (!pm) throw new Error('FTP PASV 无法解析端口: ' + r.text);
        const dataPort = (parseInt(pm[5], 10) << 8) + parseInt(pm[6], 10);
        // 数据连接一律连回控制连接的同一主机（PASV 常回内网 IP，直接用会连不通）。
        const data = net.createConnection({ host: c.ftpHost, port: dataPort });
        data.setTimeout(c.timeoutMs);
        await new Promise((res, rej) => {
          data.once('connect', res);
          data.once('error', rej);
          data.once('timeout', () => rej(new Error('FTP 数据连接超时')));
        });
        ctrl.write(`STOR ${remoteName}\r\n`);
        r = await expect();                           // 150/125 开始传输
        if (r.code !== 150 && r.code !== 125) { try { data.destroy(); } catch (_) {} throw new Error('FTP STOR 拒绝: ' + r.text); }
        await new Promise((res, rej) => {
          const rs = fs.createReadStream(localPath);
          rs.on('error', rej);
          data.on('error', rej);
          data.on('close', res);
          rs.pipe(data);                              // 传完 rs 自动 end data → 触发服务端 226
        });
        r = await expect();                           // 226/250 传输完成
        if (r.code !== 226 && r.code !== 250) throw new Error('FTP 传输未确认: ' + r.text);
        try { ctrl.write('QUIT\r\n'); } catch (_) {}
        finish(null, true);
      } catch (e) {
        finish(e);
      }
    })();
  });
}

// POST 明顺转码 API 触发切片。theme 传数组（与 python 版一致）。
async function submitTranscode(c, { title, description, videoPath, imagePath, theme }) {
  const payload = {
    title: title || videoPath,
    description: description || title || videoPath,
    image: imagePath || '',
    video: videoPath,
    md5: 'md5',
    username: c.username,
    rule: c.rule,
  };
  if (theme) payload.theme = [theme];
  const resp = await httpPostJson(c.apiUrl, payload, c.timeoutMs);
  if (resp.status >= 400) throw new Error(`明顺提交 HTTP ${resp.status}: ${String(resp.body).slice(0, 300)}`);
  let data;
  try { data = JSON.parse(resp.body); } catch (_) { throw new Error('明顺返回非 JSON: ' + String(resp.body).slice(0, 200)); }
  if (data.code !== 1) throw new Error('明顺提交失败: ' + JSON.stringify(data).slice(0, 300));
  const vid = data && data.data && data.data.video_id;
  return { video_id: vid != null ? Number(vid) : null };
}

// 切片主流程：校验 → 生成 uid → FTP 传 mp4 → POST 触发切片。返回 {video_id, remote_path, uid}。
async function sliceVideo(localPath, { title = '', description = '', theme = '' } = {}) {
  const c = cfg();
  if (!c.enabled) throw new Error('明顺切片未启用（MINGSHUN_ENABLED）');
  if (!configured(c)) throw new Error('明顺配置不完整（检查 MINGSHUN_API_URL/USERNAME/RULE/FTP_*）');
  if (!fs.existsSync(localPath)) throw new Error('成片文件不存在: ' + localPath);
  if (c.themes.length && theme && !c.themes.includes(theme)) throw new Error('非法主题: ' + theme);
  const uid = `quan_${Math.floor(Date.now() / 1000)}_${crypto.randomBytes(4).toString('hex')}`;
  const remoteName = uid + '.mp4';
  await ftpStore(c, remoteName, localPath);
  const videoPath = `/${c.username}/${remoteName}`;
  const { video_id } = await submitTranscode(c, { title, description, videoPath, theme });
  return { video_id, remote_path: videoPath, uid };
}

module.exports = { cfg, configured, sliceInfo, sliceVideo };
