import PostalMime from "postal-mime";

const MAX_MAILS = 50;
const STORAGE_KEY = "inbox";
const SESSION_KEY = "ni_session";
const SESSION_TTL = 60 * 60 * 8; // 8 hours

// ─── 收信 Handler ────────────────────────────────────────────────
export async function email(message, env) {
  const parser = new PostalMime();
  const raw = await streamToArrayBuffer(message.raw);
  const parsed = await parser.parse(raw);

  const mail = {
    id: crypto.randomUUID(),
    receivedAt: new Date().toISOString(),
    from: message.from,
    to: message.to,
    subject: parsed.subject ?? "(no subject)",
    text: parsed.text ?? "",
    html: parsed.html ?? "",
    attachments: (parsed.attachments ?? []).map((a) => ({
      filename: a.filename ?? "unknown",
      mimeType: a.mimeType ?? "application/octet-stream",
      size: a.content?.byteLength ?? 0,
    })),
  };

  const existing = await loadInbox(env);
  const updated = [mail, ...existing].slice(0, MAX_MAILS);
  await env.MAIL_KV.put(STORAGE_KEY, JSON.stringify(updated));
}

// ─── HTTP API & UI Handler ────────────────────────────────────────
export default {
  email,

  async fetch(request, env) {
    const url = new URL(request.url);

    // ── 登录 POST /login ──
    if (url.pathname === "/login" && request.method === "POST") {
      const form = await request.formData();
      const password = form.get("password") ?? "";
      if (password !== env.AUTH_KEY) {
        return html(loginPage("密码错误，请重试"));
      }
      const token = crypto.randomUUID();
      await env.MAIL_KV.put(`session:${token}`, "1", { expirationTtl: SESSION_TTL });
      return new Response(null, {
        status: 302,
        headers: {
          Location: "/",
          "Set-Cookie": `${SESSION_KEY}=${token}; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL}; Path=/`,
        },
      });
    }

    // ── 登出 GET /logout ──
    if (url.pathname === "/logout") {
      const token = getCookie(request, SESSION_KEY);
      if (token) await env.MAIL_KV.delete(`session:${token}`);
      return new Response(null, {
        status: 302,
        headers: {
          Location: "/",
          "Set-Cookie": `${SESSION_KEY}=; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Path=/`,
        },
      });
    }

    // ── 静态资源 ──
    if (url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    // ── UI 路由：需登录 ──
    if (url.pathname === "/" || url.pathname === "/mail-detail" || url.pathname === "/ui-delete") {
      const authed = await checkSession(request, env);
      if (!authed) return html(loginPage());

      // 删除操作（POST /ui-delete）
      if (url.pathname === "/ui-delete" && request.method === "POST") {
        const form = await request.formData();
        const mode = form.get("mode");
        if (mode === "all") {
          await env.MAIL_KV.delete(STORAGE_KEY);
        } else {
          const ids = form.getAll("id");
          const mails = await loadInbox(env);
          const updated = mails.filter((m) => !ids.includes(m.id));
          await env.MAIL_KV.put(STORAGE_KEY, JSON.stringify(updated));
        }
        return new Response(null, { status: 302, headers: { Location: "/" } });
      }

      if (url.pathname === "/mail-detail") {
        const id = url.searchParams.get("id");
        const mails = await loadInbox(env);
        const mail = mails.find((m) => m.id === id);
        if (!mail) return html("<p>邮件不存在</p>", 404);
        return html(detailPage(mail));
      }

      const mails = await loadInbox(env);
      return html(inboxPage(mails));
    }

    // ── JSON API：需 X-Auth-Key ──
    if (request.headers.get("X-Auth-Key") !== env.AUTH_KEY) {
      return json({ error: "unauthorized" }, 401);
    }

    const mails = await loadInbox(env);

    if (url.pathname === "/latest") {
      return mails.length ? json(mails[0]) : json({ error: "no mail" }, 404);
    }

    if (url.pathname === "/mails" && request.method === "GET") {
      const limit = Math.min(
        parseInt(url.searchParams.get("limit") ?? "10"),
        MAX_MAILS
      );
      const list = mails
        .slice(0, limit)
        .map(({ id, receivedAt, from, to, subject, attachments }) => ({
          id, receivedAt, from, to, subject, attachments,
        }));
      return json(list);
    }

    if (url.pathname === "/mails" && request.method === "DELETE") {
      await env.MAIL_KV.delete(STORAGE_KEY);
      return json({ ok: true });
    }

    const match = url.pathname.match(/^\/mail\/(.+)$/);
    if (match) {
      const found = mails.find((x) => x.id === match[1]);
      return found ? json(found) : json({ error: "not found" }, 404);
    }

    return json({ error: "unknown route" }, 404);
  },
};

// ─── Session ──────────────────────────────────────────────────────
function getCookie(request, name) {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === name) return v;
  }
  return null;
}

async function checkSession(request, env) {
  const token = getCookie(request, SESSION_KEY);
  if (!token) return false;
  const val = await env.MAIL_KV.get(`session:${token}`);
  return val === "1";
}

// ─── HTML Pages ───────────────────────────────────────────────────
function loginPage(error = "") {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ni-mail · 登录</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;background:#f4f4f5;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{background:#fff;border-radius:12px;padding:36px 32px;width:100%;max-width:360px;box-shadow:0 4px 24px rgba(0,0,0,.08)}
  h1{font-size:1.4rem;font-weight:700;margin-bottom:24px;color:#18181b}
  label{font-size:.85rem;color:#52525b;display:block;margin-bottom:6px}
  input[type=password]{width:100%;padding:10px 12px;border:1px solid #d4d4d8;border-radius:8px;font-size:1rem;outline:none;transition:border .15s}
  input[type=password]:focus{border-color:#6366f1}
  button{margin-top:16px;width:100%;padding:11px;background:#6366f1;color:#fff;border:none;border-radius:8px;font-size:1rem;cursor:pointer;font-weight:600;transition:background .15s}
  button:hover{background:#4f46e5}
  .err{color:#ef4444;font-size:.85rem;margin-top:10px}
</style>
</head>
<body>
<div class="card">
  <h1>📬 ni-mail</h1>
  <form method="POST" action="/login">
    <label for="pw">密码</label>
    <input id="pw" type="password" name="password" autofocus autocomplete="current-password" placeholder="请输入访问密码">
    <button type="submit">登录</button>
    ${error ? `<p class="err">${escHtml(error)}</p>` : ""}
  </form>
</div>
</body></html>`;
}

function inboxPage(mails) {
  const rows = mails.length === 0
    ? `<tr><td colspan="5" style="text-align:center;color:#a1a1aa;padding:40px">暂无邮件</td></tr>`
    : mails.map((m) => `
      <tr>
        <td onclick="event.stopPropagation()"><input type="checkbox" name="id" value="${m.id}" form="batch-form"></td>
        <td onclick="location.href='/mail-detail?id=${m.id}'" style="cursor:pointer">${escHtml(m.from)}</td>
        <td onclick="location.href='/mail-detail?id=${m.id}'" style="cursor:pointer">${escHtml(m.subject)}</td>
        <td onclick="location.href='/mail-detail?id=${m.id}'" style="cursor:pointer">${escHtml(m.to)}</td>
        <td onclick="location.href='/mail-detail?id=${m.id}'" style="cursor:pointer">${new Date(m.receivedAt).toLocaleString("zh")}</td>
      </tr>`).join("");

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ni-mail · 收件箱</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;background:#f4f4f5;min-height:100vh}
  header{background:#6366f1;color:#fff;padding:14px 24px;display:flex;align-items:center;justify-content:space-between}
  header h1{font-size:1.2rem;font-weight:700}
  header a{color:#fff;font-size:.85rem;text-decoration:none;opacity:.85}
  header a:hover{opacity:1}
  .wrap{max-width:960px;margin:32px auto;padding:0 16px}
  .card{background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.07);overflow:hidden}
  table{width:100%;border-collapse:collapse}
  th{text-align:left;padding:12px 16px;font-size:.8rem;color:#71717a;border-bottom:1px solid #f0f0f0;background:#fafafa}
  td{padding:13px 16px;font-size:.9rem;border-bottom:1px solid #f4f4f5;color:#27272a;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  tr:hover td{background:#f9f9ff}
  .toolbar{display:flex;align-items:center;gap:8px;margin-bottom:12px}
  .count{font-size:.85rem;color:#71717a}
  .btn{padding:7px 14px;border:none;border-radius:7px;font-size:.85rem;cursor:pointer;font-weight:600}
  .btn-del{background:#fee2e2;color:#dc2626}
  .btn-del:hover{background:#fecaca}
  .btn-all{background:#fef3c7;color:#b45309}
  .btn-all:hover{background:#fde68a}
  input[type=checkbox]{width:15px;height:15px;cursor:pointer}
</style>
</head>
<body>
<header>
  <h1>📬 ni-mail</h1>
  <a href="/logout">退出登录</a>
</header>
<div class="wrap">
  <div class="toolbar">
    <span class="count">共 <strong>${mails.length}</strong> 封邮件</span>
    <button class="btn btn-del" form="batch-form" onclick="return confirmDel()">删除选中</button>
    <button class="btn btn-all" onclick="deleteAll()">清空收件箱</button>
  </div>
  <div class="card">
    <form id="batch-form" method="POST" action="/ui-delete">
      <input type="hidden" name="mode" value="batch">
      <table>
        <thead><tr>
          <th><input type="checkbox" id="chk-all" onclick="toggleAll(this)"></th>
          <th>发件人</th><th>主题</th><th>收件人</th><th>时间</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </form>
  </div>
</div>
<form id="all-form" method="POST" action="/ui-delete" style="display:none">
  <input type="hidden" name="mode" value="all">
</form>
<script>
  function toggleAll(cb){document.querySelectorAll('input[name=id]').forEach(c=>c.checked=cb.checked)}
  function confirmDel(){
    const n=document.querySelectorAll('input[name=id]:checked').length;
    if(!n){alert('请先勾选邮件');return false;}
    return confirm('确认删除选中的 '+n+' 封邮件？');
  }
  function deleteAll(){
    if(confirm('确认清空全部邮件？'))document.getElementById('all-form').submit();
  }
</script>
</body></html>`;
}

function detailPage(mail) {
  const attachList = mail.attachments.length
    ? `<div class="att"><strong>附件：</strong>${mail.attachments.map(a =>
        `<span class="badge">${escHtml(a.filename)} (${(a.size/1024).toFixed(1)} KB)</span>`
      ).join(" ")}</div>`
    : "";

  const body = mail.html
    ? `<iframe sandbox="allow-same-origin" srcdoc="${escAttr(mail.html)}" style="width:100%;min-height:400px;border:none;border-radius:0 0 8px 8px"></iframe>`
    : `<pre style="white-space:pre-wrap;padding:20px;font-size:.9rem;line-height:1.6">${escHtml(mail.text)}</pre>`;

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(mail.subject)} · ni-mail</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;background:#f4f4f5;min-height:100vh}
  header{background:#6366f1;color:#fff;padding:14px 24px;display:flex;align-items:center;justify-content:space-between}
  header h1{font-size:1.2rem;font-weight:700}
  header a{color:#fff;font-size:.85rem;text-decoration:none;opacity:.85}
  header a:hover{opacity:1}
  .wrap{max-width:860px;margin:32px auto;padding:0 16px}
  .card{background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.07);overflow:hidden}
  .meta{padding:20px 24px;border-bottom:1px solid #f0f0f0}
  .meta h2{font-size:1.1rem;margin-bottom:12px;color:#18181b}
  .meta p{font-size:.85rem;color:#52525b;margin-bottom:4px}
  .att{padding:12px 24px;background:#fafafa;border-bottom:1px solid #f0f0f0;font-size:.85rem}
  .badge{display:inline-block;background:#f0f0ff;color:#6366f1;border-radius:4px;padding:2px 7px;font-size:.75rem;margin:2px}
  .back{display:inline-block;margin-bottom:14px;font-size:.85rem;color:#6366f1;text-decoration:none}
  .back:hover{text-decoration:underline}
</style>
</head>
<body>
<header>
  <h1>📬 ni-mail</h1>
  <a href="/logout">退出登录</a>
</header>
<div class="wrap">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
    <a class="back" href="/">← 返回收件箱</a>
    <form method="POST" action="/ui-delete" onsubmit="return confirm('确认删除此邮件？')">
      <input type="hidden" name="mode" value="batch">
      <input type="hidden" name="id" value="${escHtml(mail.id)}">
      <button type="submit" style="background:#ef4444;color:#fff;border:none;border-radius:8px;padding:7px 16px;font-size:.85rem;cursor:pointer">删除此邮件</button>
    </form>
  </div>
  <div class="card">
    <div class="meta">
      <h2>${escHtml(mail.subject)}</h2>
      <p><strong>发件人：</strong>${escHtml(mail.from)}</p>
      <p><strong>收件人：</strong>${escHtml(mail.to)}</p>
      <p><strong>时间：</strong>${new Date(mail.receivedAt).toLocaleString("zh")}</p>
    </div>
    ${attachList}
    ${body}
  </div>
</div>
</body></html>`;
}

// ─── 工具函数 ──────────────────────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function escAttr(s) {
  return String(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html;charset=UTF-8" },
  });
}

async function loadInbox(env) {
  const raw = await env.MAIL_KV.get(STORAGE_KEY);
  return raw ? JSON.parse(raw) : [];
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function streamToArrayBuffer(stream) {
  const reader = stream.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buf.buffer;
}
