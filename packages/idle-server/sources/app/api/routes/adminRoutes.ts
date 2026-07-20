import { Fastify } from "../types";
import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { accountDelete } from "@/app/account/accountDelete";
import { eventRouter } from "@/app/events/eventRouter";
import { log } from "@/utils/log";
import * as crypto from "node:crypto";

// Operator-only admin panel + account kill-switch. Gated by IDLE_ADMIN_SECRET
// (shared secret in the X-Admin-Secret header), not by account tokens. Account
// revocation invalidates credentials and disconnects active account sockets.

const ADMIN_SECRET_PATTERN = /^[0-9a-f]{64}$/i;
const ADMIN_RATE_LIMIT = { max: 5, timeWindow: '1 minute' } as const;

function applyAdminNoStore(reply: any): void {
    reply.header('Cache-Control', 'no-store');
    reply.header('Pragma', 'no-cache');
}

async function setAdminNoStore(_request: unknown, reply: any): Promise<void> {
    applyAdminNoStore(reply);
}

function adminApiOptions() {
    return {
        config: { rateLimit: ADMIN_RATE_LIMIT },
        onRequest: setAdminNoStore,
    };
}

function isAdminRequestUrl(rawUrl: string): boolean {
    const pathname = rawUrl.split(/[?#]/, 1)[0];
    return pathname === '/admin'
        || pathname === '/v1/admin'
        || pathname.startsWith('/v1/admin/');
}

function checkAdmin(request: any, reply: any): boolean {
    const secret = process.env.IDLE_ADMIN_SECRET;
    if (!secret || !ADMIN_SECRET_PATTERN.test(secret)) {
        // Fail closed unless the operator supplied 32 random bytes in the same
        // canonical transport-safe encoding used by the relay master secret.
        reply.code(503).send({ error: 'Admin API disabled' });
        return false;
    }
    const provided = request.headers['x-admin-secret'];
    if (typeof provided !== 'string') {
        reply.code(401).send({ error: 'Unauthorized' });
        return false;
    }
    const a = Buffer.from(provided);
    const b = Buffer.from(secret);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        reply.code(401).send({ error: 'Unauthorized' });
        return false;
    }
    return true;
}

export function adminRoutes(app: Fastify) {
    // Cover successful handlers, authentication failures, rate-limit errors,
    // and unknown paths inside the reserved operator namespace.
    app.addHook('onSend', (request, reply, payload, done) => {
        if (isAdminRequestUrl(request.raw.url || '')) applyAdminNoStore(reply);
        done(null, payload);
    });

    // List accounts with identifying + activity info for operator triage.
    app.get('/v1/admin/accounts', adminApiOptions(), async (request, reply) => {
        if (!checkAdmin(request, reply)) return;
        const accounts = await db.account.findMany({
            select: {
                id: true,
                firstName: true,
                lastName: true,
                username: true,
                createdAt: true,
                authSuspendedAt: true,
                githubUser: { select: { profile: true } },
            },
            orderBy: { createdAt: 'desc' },
            take: 500,
        });
        const machines = await db.machine.findMany({ select: { accountId: true, lastActiveAt: true } });
        const mByAcct = new Map<string, { count: number; lastActive: number }>();
        for (const m of machines) {
            const cur = mByAcct.get(m.accountId) || { count: 0, lastActive: 0 };
            cur.count++;
            const t = m.lastActiveAt ? new Date(m.lastActiveAt).getTime() : 0;
            if (t > cur.lastActive) cur.lastActive = t;
            mByAcct.set(m.accountId, cur);
        }
        const rows = accounts.map((a) => {
            const gh = a.githubUser?.profile as { login?: string; username?: string } | undefined;
            return {
                id: a.id,
                name: [a.firstName, a.lastName].filter(Boolean).join(' ') || null,
                username: a.username,
                github: gh?.login ?? gh?.username ?? (a.githubUser ? 'linked' : null),
                createdAt: a.createdAt,
                machines: mByAcct.get(a.id)?.count || 0,
                lastActive: mByAcct.get(a.id)?.lastActive || null,
                status: a.authSuspendedAt ? 'suspended' : 'enabled',
                suspendedAt: a.authSuspendedAt,
            };
        });
        return reply.send({
            accounts: rows,
            stats: auth.adminStats(),
            total: rows.length,
            suspended: rows.filter((account) => account.status === 'suspended').length,
        });
    });

    // Kill-switch: durably suspend both bearer-token and account-key
    // authentication, then terminate live connections across relay replicas.
    app.post('/v1/admin/accounts/:userId/revoke', adminApiOptions(), async (request: any, reply) => {
        if (!checkAdmin(request, reply)) return;
        const userId: string = request.params?.userId;
        if (typeof userId !== 'string' || userId.length < 3) {
            return reply.code(400).send({ error: 'userId required' });
        }
        const suspension = await auth.suspendUser(userId);
        if (!suspension.found) {
            return reply.code(404).send({ error: 'Account not found' });
        }
        await eventRouter.disconnectUserConnections(userId);
        log({ module: 'admin' }, 'Operator suspended an account');
        return reply.send({
            userId,
            status: 'suspended',
            revokedTokens: suspension.invalidatedTokens,
        });
    });

    // Enabling is intentionally operator-only and explicit. The signing key may
    // authenticate again, while all pre-suspension bearer generations stay stale.
    app.post('/v1/admin/accounts/:userId/enable', adminApiOptions(), async (request: any, reply) => {
        if (!checkAdmin(request, reply)) return;
        const userId: string = request.params?.userId;
        if (typeof userId !== 'string' || userId.length < 3) {
            return reply.code(400).send({ error: 'userId required' });
        }
        if (!await auth.resumeUser(userId)) {
            return reply.code(404).send({ error: 'Account not found' });
        }
        log({ module: 'admin' }, 'Operator enabled an account');
        return reply.send({ userId, status: 'enabled' });
    });

    // Bulk cleanup of stale accounts: those with ZERO registered machines
    // (paired once and abandoned — mostly test-run debris). Safe by
    // construction: it can only ever target machine-less accounts, and it
    // additionally protects anything created in the last 3 days. dryRun by
    // default; pass ?execute=true to actually delete via the tested
    // accountDelete path.
    app.post('/v1/admin/cleanup-stale', adminApiOptions(), async (request: any, reply) => {
        if (!checkAdmin(request, reply)) return;
        const execute = request.query?.execute === 'true';
        const accounts = await db.account.findMany({
            select: { id: true, createdAt: true, _count: { select: { Machine: true } } },
        });
        const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000; // never touch accounts < 3 days old
        const stale = accounts.filter(
            (a) => a._count.Machine === 0 && new Date(a.createdAt).getTime() < cutoff,
        );
        if (!execute) {
            return reply.send({ dryRun: true, wouldDelete: stale.length, sample: stale.slice(0, 8).map((a) => a.id) });
        }
        let deleted = 0;
        for (const a of stale) {
            try {
                await accountDelete({ uid: a.id });
                deleted++;
            } catch {
                log({ module: 'admin', level: 'error' }, 'Stale-account cleanup item failed');
            }
        }
        log({ module: 'admin', deletedCount: deleted, attemptedCount: stale.length }, 'Stale-account cleanup completed');
        return reply.send({ dryRun: false, deleted, attempted: stale.length });
    });

    // Serve the panel. The page itself is public (just a login form); every
    // data/action call it makes requires the admin secret.
    app.get('/admin', { onRequest: setAdminNoStore }, async (_request, reply) => {
        reply.header('X-Robots-Tag', 'noindex, nofollow');
        reply.header('Referrer-Policy', 'no-referrer');
        reply.header('X-Frame-Options', 'DENY');
        reply.header('Content-Security-Policy', PANEL_CSP);
        reply.type('text/html').send(PANEL_HTML);
    });
}

const PANEL_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Idle Admin</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{font:14px/1.5 -apple-system,system-ui,sans-serif;margin:0;background:#0d1117;color:#e6edf3}
header{padding:14px 20px;border-bottom:1px solid #21262d;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
h1{font-size:16px;margin:0;font-weight:600}
.stat{color:#8b949e;font-size:12px}
main{padding:16px 20px}
input{background:#010409;border:1px solid #30363d;color:#e6edf3;border-radius:6px;padding:8px 10px;font-size:14px}
button{background:#238636;border:0;color:#fff;border-radius:6px;padding:7px 12px;cursor:pointer;font-size:13px}
button.danger{background:#da3633}
button:disabled{opacity:.5;cursor:default}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #21262d;vertical-align:middle}
th{color:#8b949e;font-weight:500}
td.id{font-family:ui-monospace,monospace;font-size:11px;color:#8b949e}
tr:hover{background:#161b22}
.login{max-width:360px;margin:64px auto;text-align:center}
.err{color:#f85149;margin:8px 0}
.muted{color:#8b949e}
.full{width:100%}
.hidden{display:none}
.spacer{flex:1}
.cleanup{background:#8957e5}
</style></head>
<body>
<div id="login" class="login">
  <h1>Idle Admin</h1>
  <p class="muted">Enter the admin secret.</p>
  <input id="secret" class="full" type="password" placeholder="admin secret" autocomplete="off"><br><br>
  <button id="loginButton">Sign in</button>
  <div id="loginErr" class="err"></div>
</div>
<div id="app" class="hidden">
<header><h1>Idle Admin</h1><span class="stat" id="stats"></span><span class="spacer"></span>
<button id="cleanupButton" class="cleanup">Clean up stale</button><button id="refreshButton">Refresh</button><button id="lockButton" class="danger">Lock</button></header>
<main><div id="err" class="err"></div>
<table><thead><tr><th>Account ID</th><th>Name / username</th><th>GitHub</th><th>Created</th><th>Machines</th><th>Last active</th><th>Status</th><th></th></tr></thead><tbody id="rows"></tbody></table></main>
</div>
<script>
let adminSecret='';
const S=()=>adminSecret;
const hdr=()=>({'X-Admin-Secret':S()});
const fmt=(t)=>t?new Date(t).toLocaleString():'\\u2014';
const MAX_ADMIN_JSON_BYTES=1024*1024;
async function readAdminJson(response){
  const declared=response.headers.get('content-length');
  if(declared!==null&&(!/^\\d+$/.test(declared)||Number(declared)>MAX_ADMIN_JSON_BYTES))throw new Error('Admin response exceeded the byte limit');
  if(!response.body)throw new Error('Admin response body unavailable');
  const reader=response.body.getReader();
  const chunks=[];let total=0;
  try{
    while(true){
      const next=await reader.read();if(next.done)break;if(!next.value)continue;
      total+=next.value.byteLength;
      if(total>MAX_ADMIN_JSON_BYTES){await reader.cancel();throw new Error('Admin response exceeded the byte limit');}
      chunks.push(next.value);
    }
  }finally{reader.releaseLock();}
  const bytes=new Uint8Array(total);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
async function load(){
  document.getElementById('err').textContent='';
  let r;
  try{r=await fetch('/v1/admin/accounts',{headers:hdr()});}catch(e){document.getElementById('err').textContent='Network error';return;}
  if(!r.ok){document.getElementById('err').textContent='Load failed ('+r.status+')';if(r.status===401)logout();return;}
  let d;
  try{d=await readAdminJson(r);}catch(e){document.getElementById('err').textContent='Invalid server response';return;}
  document.getElementById('stats').textContent=d.total+' accounts \\u00b7 '+d.suspended+' suspended \\u00b7 '+d.stats.tokenCacheSize+' cached tokens';
  const tb=document.getElementById('rows');tb.innerHTML='';
  for(const a of d.accounts){
    const tr=document.createElement('tr');
    const cells=['','','','','','','',''].map(()=>document.createElement('td'));
    cells[0].className='id';cells[0].textContent=a.id;
    cells[1].textContent=((a.name||'')+(a.username?' @'+a.username:''))||'\\u2014';
    cells[2].textContent=a.github||'\\u2014';
    cells[3].className='muted';cells[3].textContent=fmt(a.createdAt);
    cells[4].textContent=a.machines;
    cells[5].className='muted';cells[5].textContent=fmt(a.lastActive);
    cells[6].textContent=a.status==='suspended'?'Suspended':'Enabled';
    cells[6].className=a.status==='suspended'?'err':'muted';
    const btn=document.createElement('button');btn.className=a.status==='suspended'?'':'danger';btn.textContent=a.status==='suspended'?'Enable':'Suspend';
    btn.addEventListener('click',()=>setAccountState(a,btn));
    cells[7].appendChild(btn);
    cells.forEach(c=>tr.appendChild(c));
    tb.appendChild(tr);
  }
}
async function setAccountState(account,btn){
  const enabling=account.status==='suspended';
  const label=enabling?'Enable account':'Suspend account';
  const detail=enabling?'The account credential may authenticate again; old bearer tokens stay revoked.':'Active connections will close and the account credential cannot authenticate until explicitly enabled.';
  if(!confirm(label+' '+account.id+'?\\n'+detail))return;
  btn.disabled=true;btn.textContent='...';
  try{
    const path=enabling?'/enable':'/revoke';
    const r=await fetch('/v1/admin/accounts/'+encodeURIComponent(account.id)+path,{method:'POST',headers:hdr()});
    if(r.ok){btn.textContent=enabling?'Enabled':'Suspended';}else{btn.textContent='Failed';btn.disabled=false;}
  }catch(e){btn.textContent='Error';btn.disabled=false;}
  setTimeout(load,300);
}
async function cleanup(){
  let dry;
  try{const response=await fetch('/v1/admin/cleanup-stale',{method:'POST',headers:hdr()});if(!response.ok)throw new Error('request failed');dry=await readAdminJson(response);}catch(e){alert('Dry-run failed');return;}
  if(!confirm('Delete '+dry.wouldDelete+' stale accounts (0 machines, >3 days old)?\\nThis permanently removes them.'))return;
  let r;
  try{const response=await fetch('/v1/admin/cleanup-stale?execute=true',{method:'POST',headers:hdr()});if(!response.ok)throw new Error('request failed');r=await readAdminJson(response);}catch(e){alert('Cleanup failed');return;}
  alert('Deleted '+r.deleted+' of '+r.attempted+' stale accounts.');
  load();
}
function login(){const input=document.getElementById('secret');const v=input.value.trim();if(!v)return;adminSecret=v;input.value='';show();}
function logout(){adminSecret='';document.getElementById('app').classList.add('hidden');document.getElementById('login').classList.remove('hidden');}
function show(){document.getElementById('login').classList.add('hidden');document.getElementById('app').classList.remove('hidden');load();}
document.getElementById('loginButton').addEventListener('click',login);
document.getElementById('cleanupButton').addEventListener('click',cleanup);
document.getElementById('refreshButton').addEventListener('click',load);
document.getElementById('lockButton').addEventListener('click',logout);
document.getElementById('secret').addEventListener('keydown',(event)=>{if(event.key==='Enter')login();});
</script>
</body></html>`;

function inlinePanelSource(tag: 'style' | 'script'): string {
    const match = PANEL_HTML.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
    if (!match) throw new Error(`Admin panel ${tag} source missing`);
    return match[1];
}

function cspHash(source: string): string {
    return crypto.createHash('sha256').update(source, 'utf8').digest('base64');
}

const PANEL_CSP = [
    "default-src 'none'",
    "base-uri 'none'",
    "connect-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "img-src 'none'",
    "object-src 'none'",
    `script-src 'sha256-${cspHash(inlinePanelSource('script'))}'`,
    `style-src 'sha256-${cspHash(inlinePanelSource('style'))}'`,
    "worker-src 'none'",
].join('; ');
