import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const DB_PATH = path.join(__dirname, 'data.json');
const PORT = Number(process.env.PORT || 3000);
const KICK_CLIENT_ID = process.env.KICK_CLIENT_ID || '';
const KICK_CLIENT_SECRET = process.env.KICK_CLIENT_SECRET || '';
const KICK_REDIRECT_URI = process.env.KICK_REDIRECT_URI || `http://localhost:${PORT}/oauth/callback`;
const ENC_SECRET = process.env.APP_ENCRYPTION_KEY || 'dev-only-change-me';

const API = 'https://api.kick.com/public';
const OAUTH = 'https://id.kick.com';
const accounts = new Map();
const channels = new Map();
const botConfig = { running: false, accountDelaySec: 10, selectedAccountIds: [] };
const runtime = { timers: new Map(), statuses: new Map(), lastRefreshAt: null };
const oauthPending = new Map();

async function loadDb() {
  try {
    const raw = await fs.readFile(DB_PATH, 'utf8');
    const data = JSON.parse(raw);
    for (const a of (data.accounts || [])) accounts.set(a.id, a);
    for (const c of (data.channels || [])) channels.set(c.id, c);
    Object.assign(botConfig, data.botConfig || {});
  } catch {}
}
async function saveDb() {
  const data = { accounts: [...accounts.values()], channels: [...channels.values()], botConfig };
  await fs.writeFile(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
}
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}
function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function encrypt(text) {
  const key = crypto.createHash('sha256').update(ENC_SECRET).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${b64url(iv)}.${b64url(tag)}.${b64url(ct)}`;
}
function decrypt(payload) {
  const [ivB, tagB, ctB] = String(payload).split('.');
  const key = crypto.createHash('sha256').update(ENC_SECRET).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64url')), decipher.final()]).toString('utf8');
}
function pubAccount(a) {
  return { id: a.id, username: a.username, userId: a.userId, enabled: a.enabled !== false, status: a.status || 'stopped', expiresAt: a.expiresAt || null };
}
function pubChannel(c) {
  return { id: c.id, slug: c.slug, username: c.username, broadcasterUserId: c.broadcasterUserId, live: Boolean(runtime.statuses.get(c.id)), botId: c.botId, messages: c.messages || [], randomMessages: !!c.randomMessages, randomDelay: c.randomDelay || { enabled: false, from: 300, to: 900 }, repeat: !!c.repeat };
}
function getAccount(aid) {
  const a = accounts.get(aid); if (!a) throw new Error('Account not found'); return a;
}
function getChannel(cid) {
  const c = channels.get(cid); if (!c) throw new Error('Channel not found'); return c;
}
async function kickFetch(urlPath, token, options={}) {
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}`, Accept: 'application/json' };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${API}${urlPath}`, { ...options, headers });
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!r.ok) { const err = new Error(data?.message || data?.error || `Kick API ${r.status}`); err.status = r.status; err.data = data; throw err; }
  return data;
}
async function tokenRequest(form) {
  const r = await fetch(`${OAUTH}/oauth/token`, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams(form) });
  const text = await r.text(); let data; try { data=JSON.parse(text); } catch { data={message:text}; }
  if (!r.ok) { const e=new Error(data?.error_description || data?.error || `OAuth ${r.status}`); e.status=r.status; throw e; }
  return data;
}
async function refreshAccount(a) {
  const refreshToken = decrypt(a.refreshTokenEnc);
  const data = await tokenRequest({ grant_type:'refresh_token', refresh_token:refreshToken, client_id:KICK_CLIENT_ID, client_secret:KICK_CLIENT_SECRET });
  a.accessTokenEnc = encrypt(data.access_token);
  if (data.refresh_token) a.refreshTokenEnc = encrypt(data.refresh_token);
  a.expiresAt = Date.now() + Number(data.expires_in || 0) * 1000;
  a.status = 'stopped';
  await saveDb();
  return a;
}
async function ensureFresh(a) {
  if (!a.expiresAt || a.expiresAt - Date.now() < 60_000) {
    try { await refreshAccount(a); } catch { a.status='expired'; await saveDb(); throw new Error('Token expired and refresh failed'); }
  }
  return decrypt(a.accessTokenEnc);
}
async function resolveUser(accessToken) {
  const data = await kickFetch('/v1/users', accessToken);
  const user = Array.isArray(data?.data) ? data.data[0] : data?.data;
  if (!user) throw new Error('No user returned by Kick API');
  return user;
}
async function resolveChannel(accessToken, slug) {
  const data = await kickFetch(`/v1/channels?slug=${encodeURIComponent(slug)}`, accessToken);
  const ch = Array.isArray(data?.data) ? data.data[0] : data?.data;
  if (!ch) throw new Error('Channel not found');
  return ch;
}
async function isLive(accessToken, broadcasterUserId) {
  const data = await kickFetch(`/v2/livestreams?broadcaster_user_id=${encodeURIComponent(broadcasterUserId)}&limit=1`, accessToken);
  return Array.isArray(data?.data) ? data.data.length > 0 : Boolean(data?.data);
}
async function sendMessage(a, c, content) {
  const token = await ensureFresh(a);
  return kickFetch('/v1/chat', { [Symbol.toStringTag]:'noop' });
}

async function postChat(account, channel, content) {
  const token = await ensureFresh(account);
  return kickFetch('/v1/chat', token, { method:'POST', body:JSON.stringify({ broadcaster_user_id:Number(channel.broadcasterUserId), content, type:'bot' }) });
}
function pickMessage(c) {
  const valid = (c.messages || []).map(x=>String(x).trim()).filter(Boolean);
  if (!valid.length) return '';
  return valid[Math.floor(Math.random()*valid.length)];
}
function clearChannelTimer(cid) { const t=runtime.timers.get(cid); if (t) clearTimeout(t); runtime.timers.delete(cid); }
function scheduleChannel(c) {
  clearChannelTimer(c.id);
  if (!botConfig.running) return;
  if (!runtime.statuses.get(c.id)) return;
  const selected = Array.isArray(botConfig.selectedAccountIds) && botConfig.selectedAccountIds.length ? new Set(botConfig.selectedAccountIds) : null;
  const activeAccounts = [...accounts.values()].filter(a=>a.enabled !== false && a.status !== 'expired' && (!selected || selected.has(a.id)));
  if (!activeAccounts.length) return;
  let ai = 0;
  let mi = 0;
  let sentCount = 0;
  const tick = async () => {
    if (!botConfig.running || !runtime.statuses.get(c.id)) return;
    if (!c.repeat && sentCount >= Math.max(1, Number(c.messages?.length || 1))) return;
    const a = activeAccounts[ai % activeAccounts.length]; ai++;
    const msgList = (c.messages || []).map(x=>String(x).trim()).filter(Boolean);
    if (!msgList.length) return;
    const msg = c.randomMessages ? msgList[Math.floor(Math.random()*msgList.length)] : msgList[mi++ % msgList.length];
    try { await postChat(a, c, msg); a.status='running'; sentCount++; } catch (e) { if (e.status===401) a.status='expired'; }
    await saveDb();
    const messageDelay = c.randomDelay?.enabled ? (c.randomDelay.from + Math.random()*(c.randomDelay.to-c.randomDelay.from)) : (c.delaySec || 60);
    const stagger = Number(botConfig.accountDelaySec || 10);
    runtime.timers.set(c.id, setTimeout(tick, Math.max(1, Math.max(messageDelay, stagger))*1000));
  };
  // First send follows the account-stagger setting, keeping the UI behavior predictable.
  runtime.timers.set(c.id, setTimeout(tick, Math.max(1, Number(botConfig.accountDelaySec||10))*1000));
}

async function refreshStatuses() {
  runtime.lastRefreshAt = new Date().toISOString();
  for (const c of channels.values()) {
    const candidates = [...accounts.values()].filter(a=>a.enabled !== false && a.status !== 'expired');
    let live=false;
    for (const a of candidates) {
      try { const token=await ensureFresh(a); live=await isLive(token,c.broadcasterUserId); if (live || !c.requiresAccount) break; } catch {}
    }
    runtime.statuses.set(c.id, live);
    if (live) scheduleChannel(c); else clearChannelTimer(c.id);
  }
}
setInterval(refreshStatuses, 45_000);

async function handleApi(req,res,url) {
  try {
    if (req.method==='GET' && url.pathname==='/api/state') {
      return json(res,200,{ accounts:[...accounts.values()].map(pubAccount), channels:[...channels.values()].map(pubChannel), botConfig, lastRefreshAt:runtime.lastRefreshAt });
    }
    if (req.method==='POST' && url.pathname==='/api/config') {
      const b=await body(req); botConfig.running=!!b.running; botConfig.accountDelaySec=Math.max(1,Number(b.accountDelaySec||10));
      if (botConfig.running) { for (const c of channels.values()) scheduleChannel(c); } else { for (const cid of channels.keys()) clearChannelTimer(cid); }
      for (const a of accounts.values()) a.status=botConfig.running && a.enabled!==false ? 'running':'stopped';
      await saveDb(); return json(res,200,{ok:true});
    }
    if (req.method==='POST' && url.pathname==='/api/accounts/token') {
      const b=await body(req); const at=String(b.accessToken||'').trim(), rt=String(b.refreshToken||'').trim();
      if (!at || !rt) return json(res,400,{error:'Access token and refresh token are required.'});
      const user=await resolveUser(at); const id=crypto.randomUUID();
      accounts.set(id,{id,userId:String(user.user_id),username:user.name||user.username||'unknown',accessTokenEnc:encrypt(at),refreshTokenEnc:encrypt(rt),expiresAt:b.expiresAt||null,enabled:true,status:'stopped'});
      await saveDb(); return json(res,200,{account:pubAccount(accounts.get(id))});
    }
    if (req.method==='POST' && url.pathname==='/api/accounts/oauth/start') {
      if(!KICK_CLIENT_ID) return json(res,500,{error:'KICK_CLIENT_ID is missing in .env'});
      const state=crypto.randomBytes(24).toString('hex'); const verifier=b64url(crypto.randomBytes(32));
      const challenge=b64url(crypto.createHash('sha256').update(verifier).digest());
      oauthPending.set(state,{verifier,createdAt:Date.now()});
      const scope='user:read channel:read chat:write events:subscribe';
      const u=new URL(`${OAUTH}/oauth/authorize`); u.searchParams.set('response_type','code'); u.searchParams.set('client_id',KICK_CLIENT_ID); u.searchParams.set('redirect_uri',KICK_REDIRECT_URI); u.searchParams.set('scope',scope); u.searchParams.set('state',state); u.searchParams.set('code_challenge',challenge); u.searchParams.set('code_challenge_method','S256');
      return json(res,200,{url:u.toString()});
    }
    if (req.method==='POST' && url.pathname==='/api/accounts/refresh') {
      const b=await body(req); const a=getAccount(b.id); await refreshAccount(a); return json(res,200,{account:pubAccount(a)});
    }
    if (req.method==='DELETE' && url.pathname.startsWith('/api/accounts/')) {
      const id=url.pathname.split('/').pop(); accounts.delete(id); await saveDb(); return json(res,200,{ok:true});
    }
    if (req.method==='POST' && url.pathname==='/api/accounts/check') {
      const b=await body(req); const result=[];
      for(const a of accounts.values()) { try { const t=await ensureFresh(a); await resolveUser(t); a.status='stopped'; result.push({id:a.id,expired:false}); } catch { a.status='expired'; result.push({id:a.id,expired:true}); } }
      await saveDb(); return json(res,200,{result});
    }
    if (req.method==='POST' && url.pathname==='/api/channels') {
      const b=await body(req); const a=getAccount(b.accountId); const slug=String(b.slug||'').trim().replace(/^https?:\/\/kick\.com\//,'').replace(/\/$/,'');
      if(!slug) return json(res,400,{error:'Enter a channel slug.'});
      const ch=await resolveChannel(await ensureFresh(a),slug); const id=crypto.randomUUID();
      const item={id,slug:ch.slug||slug,username:ch.user?.username||ch.name||slug,broadcasterUserId:String(ch.broadcaster_user_id),messages:[],randomMessages:false,randomDelay:{enabled:false,from:300,to:900},repeat:false,delaySec:60,accountId:a.id};
      channels.set(id,item); await saveDb(); await refreshStatuses(); return json(res,200,{channel:pubChannel(item)});
    }
    if (req.method==='DELETE' && url.pathname.startsWith('/api/channels/')) { const id=url.pathname.split('/').pop(); channels.delete(id); clearChannelTimer(id); await saveDb(); return json(res,200,{ok:true}); }
    if (req.method==='PATCH' && url.pathname.startsWith('/api/channels/')) {
      const id=url.pathname.split('/').pop(); const c=getChannel(id); const b=await body(req);
      if (Array.isArray(b.messages)) c.messages=b.messages;
      if (typeof b.randomMessages==='boolean') c.randomMessages=b.randomMessages;
      if (b.randomDelay) c.randomDelay={enabled:!!b.randomDelay.enabled,from:Math.max(1,Number(b.randomDelay.from||300)),to:Math.max(1,Number(b.randomDelay.to||900))};
      if (b.delaySec) c.delaySec=Math.max(1,Number(b.delaySec));
      if (typeof b.repeat==='boolean') c.repeat=b.repeat;
      await saveDb(); if(botConfig.running) scheduleChannel(c); return json(res,200,{channel:pubChannel(c)});
    }
    if (req.method==='POST' && url.pathname==='/api/backup/export') {
      const b=await body(req); const password=String(b.password||''); if(password.length<6) return json(res,400,{error:'Export password must be at least 6 characters.'});
      const plain=JSON.stringify({version:1,createdAt:new Date().toISOString(),accounts:[...accounts.values()],channels:[...channels.values()]});
      const key=crypto.pbkdf2Sync(password,'kick-panel-export',120000,32,'sha256'); const iv=crypto.randomBytes(12); const cipher=crypto.createCipheriv('aes-256-gcm',key,iv); const ct=Buffer.concat([cipher.update(plain,'utf8'),cipher.final()]); const tag=cipher.getAuthTag();
      const code=JSON.stringify({v:1,iv:b64url(iv),tag:b64url(tag),data:b64url(ct)});
      return json(res,200,{code:Buffer.from(code).toString('base64url')});
    }
    if (req.method==='POST' && url.pathname==='/api/backup/import') {
      const b=await body(req); const password=String(b.password||''); const code=Buffer.from(String(b.code||''),'base64url').toString('utf8'); const obj=JSON.parse(code); const key=crypto.pbkdf2Sync(password,'kick-panel-export',120000,32,'sha256'); const d=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(obj.iv,'base64url')); d.setAuthTag(Buffer.from(obj.tag,'base64url')); const plain=Buffer.concat([d.update(Buffer.from(obj.data,'base64url')),d.final()]).toString('utf8'); const data=JSON.parse(plain);
      for(const a of (data.accounts||[])) accounts.set(a.id,a); for(const c of (data.channels||[])) channels.set(c.id,c); await saveDb(); await refreshStatuses(); return json(res,200,{ok:true});
    }
    if (req.method==='POST' && url.pathname==='/api/test-message') {
      const b=await body(req); const a=getAccount(b.accountId); const c=getChannel(b.channelId); const msg=String(b.content||'').trim(); if(!msg) return json(res,400,{error:'Message is empty.'}); const r=await postChat(a,c,msg); return json(res,200,{ok:true,data:r});
    }
    return json(res,404,{error:'Not found'});
  } catch(e) { return json(res,e.status||500,{error:e.message}); }
}

async function serve(req,res) {
  const url=new URL(req.url,`http://${req.headers.host}`);
  if(url.pathname.startsWith('/api/')) return handleApi(req,res,url);
  if(req.method==='GET' && url.pathname==='/oauth/callback') {
    const state=url.searchParams.get('state'), code=url.searchParams.get('code'); const pending=state&&oauthPending.get(state); oauthPending.delete(state);
    if(!pending || !code) { res.writeHead(400,{'Content-Type':'text/plain'}); return res.end('OAuth callback is invalid.'); }
    try {
      const token=await tokenRequest({grant_type:'authorization_code',code,client_id:KICK_CLIENT_ID,client_secret:KICK_CLIENT_SECRET,redirect_uri:KICK_REDIRECT_URI,code_verifier:pending.verifier});
      const user=await resolveUser(token.access_token); const id=crypto.randomUUID(); accounts.set(id,{id,userId:String(user.user_id),username:user.name||user.username||'unknown',accessTokenEnc:encrypt(token.access_token),refreshTokenEnc:encrypt(token.refresh_token),expiresAt:Date.now()+Number(token.expires_in||0)*1000,enabled:true,status:'stopped'}); await saveDb(); res.writeHead(302,{Location:'/'}); return res.end();
    } catch(e) { res.writeHead(500,{'Content-Type':'text/plain'}); return res.end(`OAuth error: ${e.message}`); }
  }
  let file=url.pathname==='/'?'/index.html':url.pathname; const fp=path.normalize(path.join(PUBLIC,file)); if(!fp.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
  try { const ext=path.extname(fp); const type={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg'}[ext]||'text/plain; charset=utf-8'; const data=await fs.readFile(fp); res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'}); res.end(data); } catch { res.writeHead(404); res.end('Not found'); }
}

await loadDb();
await refreshStatuses().catch(()=>{});
http.createServer(serve).listen(PORT,()=>console.log(`Kick panel running on http://localhost:${PORT}`));
