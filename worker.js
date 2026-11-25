// Athena AI agent — Cybersecurity Vulnerability Explorer
// MCP server (stateless Streamable HTTP, JSON) as a single-file Cloudflare Worker. Endpoint: /mcp
// Data: NIST National Vulnerability Database (NVD) CVE API 2.0 (public, no key). Fallback: CISA KEV catalog.

const TOOL_NAME = "search_vulnerabilities";
const WIDGET_URI = "ui://widget/vuln-explorer.html";
const UA = { "user-agent": "athena-vuln-explorer/1.0 (hello@hassankhachab.dev)" };

function sevOf(score) { if (score == null) return "NONE"; if (score >= 9) return "CRITICAL"; if (score >= 7) return "HIGH"; if (score >= 4) return "MEDIUM"; if (score > 0) return "LOW"; return "NONE"; }
function nvdDate(d) { return d.toISOString().replace("Z", "+00:00"); }

function parseCve(c) {
  const m = c.metrics || {};
  const pick = m.cvssMetricV31?.[0] || m.cvssMetricV40?.[0] || m.cvssMetricV30?.[0] || m.cvssMetricV2?.[0];
  const score = pick?.cvssData?.baseScore ?? null;
  const severity = (pick?.cvssData?.baseSeverity || pick?.baseSeverity || sevOf(score)).toUpperCase();
  let vendor = "", product = "";
  for (const cfg of c.configurations || []) for (const n of cfg.nodes || []) for (const cm of n.cpeMatch || []) {
    if (!vendor && cm.criteria) { const p = cm.criteria.split(":"); vendor = p[3] || ""; product = p[4] || ""; }
  }
  const desc = (c.descriptions || []).find(d => d.lang === "en")?.value || "";
  return {
    id: c.id, published: c.published, score, severity,
    vendor: vendor.replace(/_/g, " ") || ((s) => { const d = ((s || "").split("@")[1] || "").split(".").slice(-2, -1)[0] || ""; return d && !["mitre", "github", "wordfence", "patchstack", "vuldb", "vulncheck", "hackerone", "incibe", "jpcert"].includes(d) ? d : "unknown"; })(c.sourceIdentifier), product: product.replace(/_/g, " ") || "—",
    vector: pick?.cvssData?.vectorString || "", description: desc,
    url: "https://nvd.nist.gov/vuln/detail/" + c.id,
  };
}

async function fromNvd({ keyword, severity, days, limit }) {
  const end = new Date(), start = new Date(end.getTime() - days * 864e5);
  const base = new URLSearchParams({ pubStartDate: nvdDate(start), pubEndDate: nvdDate(end) });
  if (keyword) base.set("keywordSearch", keyword);
  if (severity) base.set("cvssV3Severity", severity);
  const api = "https://services.nvd.nist.gov/rest/json/cves/2.0?";
  // 1st call: total count; 2nd call: newest page (NVD sorts oldest first)
  const head = await fetch(api + base + "&resultsPerPage=1", { headers: UA });
  if (!head.ok) throw new Error("NVD " + head.status);
  const total = (await head.json()).totalResults || 0;
  if (!total) return { total: 0, items: [] };
  const p = new URLSearchParams(base); p.set("resultsPerPage", String(limit)); p.set("startIndex", String(Math.max(0, total - limit)));
  const r = await fetch(api + p, { headers: UA });
  if (!r.ok) throw new Error("NVD " + r.status);
  const j = await r.json();
  const items = (j.vulnerabilities || []).map(v => parseCve(v.cve)).sort((a, b) => b.published.localeCompare(a.published));
  return { total, items };
}

async function fromKev({ keyword, days, limit }) {
  const r = await fetch("https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json", { headers: UA });
  const j = await r.json(); const since = Date.now() - days * 864e5; const q = (keyword || "").toLowerCase();
  const items = j.vulnerabilities.filter(v => new Date(v.dateAdded).getTime() >= since && (!q || (v.vendorProject + " " + v.product + " " + v.vulnerabilityName).toLowerCase().includes(q)))
    .map(v => ({ id: v.cveID, published: v.dateAdded + "T00:00:00", score: null, severity: "KEV", vendor: v.vendorProject, product: v.product, vector: "", description: v.shortDescription, url: "https://nvd.nist.gov/vuln/detail/" + v.cveID }))
    .sort((a, b) => b.published.localeCompare(a.published)).slice(0, limit);
  return { total: items.length, items };
}

async function search(args) {
  const keyword = (args?.keyword || "").trim();
  const severity = (args?.severity || "").toUpperCase();
  const days = Math.min(Math.max(parseInt(args?.days) || 30, 1), 120);
  const limit = Math.min(Math.max(parseInt(args?.limit) || 60, 5), 100);
  let res, source = "NIST National Vulnerability Database (NVD) CVE API 2.0";
  try { res = await fromNvd({ keyword, severity: ["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(severity) ? severity : "", days, limit }); }
  catch (e) { res = await fromKev({ keyword, days, limit }); source = "CISA Known Exploited Vulnerabilities catalog (NVD unavailable)"; }
  return { keyword, severity, days, source, fetchedAt: new Date().toISOString(), total: res.total, count: res.items.length, items: res.items };
}

const TOOL = {
  name: TOOL_NAME,
  title: "Search live CVE vulnerabilities",
  description: "Search real, live cybersecurity vulnerabilities (CVEs) from the NIST National Vulnerability Database by vendor or product keyword, CVSS severity and publication date window, and show them in an interactive explorer widget. Use for any question about vulnerabilities, CVEs, security flaws, a vendor's or product's vulnerabilities, or recent critical vulnerabilities.",
  inputSchema: {
    type: "object",
    properties: {
      keyword: { type: "string", description: "Vendor or product keyword, e.g. 'microsoft', 'apache', 'wordpress', 'cisco'. Empty = all." },
      severity: { type: "string", enum: ["", "LOW", "MEDIUM", "HIGH", "CRITICAL"], description: "Optional CVSS v3 severity filter" },
      days: { type: "number", description: "Published in the last N days (1-120, default 30)" },
      limit: { type: "number", description: "Max CVEs to return (default 60)" },
    },
  },
  _meta: {
    "openai/outputTemplate": WIDGET_URI,
    "openai/widgetAccessible": true,
    "openai/toolInvocation/invoking": "Querying the National Vulnerability Database…",
    "openai/toolInvocation/invoked": "Vulnerabilities loaded",
  },
};

async function callTool(args) {
  const data = await search(args);
  const bySev = data.items.reduce((a, i) => (a[i.severity] = (a[i.severity] || 0) + 1, a), {});
  const top = data.items.filter(i => i.score != null).sort((a, b) => b.score - a.score).slice(0, 3).map(i => i.id + " (" + i.vendor + " " + i.product + ", CVSS " + i.score + ")").join("; ");
  const text = "Found " + data.total + " CVEs published in the last " + data.days + " days" + (data.keyword ? ' matching "' + data.keyword + '"' : "") + (data.severity ? " with " + data.severity + " severity" : "") + " (showing " + data.count + " newest) from " + data.source + ". Severity mix: " + JSON.stringify(bySev) + ". Highest: " + (top || "n/a") + ".";
  return {
    structuredContent: data,
    content: [{ type: "text", text }],
    _meta: { "openai/outputTemplate": WIDGET_URI },
  };
}

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS", "Access-Control-Allow-Headers": "content-type, mcp-session-id, mcp-protocol-version, authorization", "Access-Control-Expose-Headers": "Mcp-Session-Id" };

async function rpc(msg) {
  const { id, method, params } = msg; const ok = result => ({ jsonrpc: "2.0", id, result });
  switch (method) {
    case "initialize": return ok({ protocolVersion: params?.protocolVersion || "2025-06-18", capabilities: { tools: { listChanged: false }, resources: { listChanged: false } }, serverInfo: { name: "vuln-explorer", version: "1.0.0" } });
    case "ping": return ok({});
    case "tools/list": return ok({ tools: [TOOL] });
    case "tools/call":
      if (params?.name !== TOOL_NAME) return { jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown tool" } };
      try { return ok(await callTool(params.arguments || {})); } catch (e) { return ok({ isError: true, content: [{ type: "text", text: "Data source error: " + e.message }] }); }
    case "resources/list": return ok({ resources: [{ uri: WIDGET_URI, name: "vuln-explorer-widget", mimeType: "text/html+skybridge" }] });
    case "resources/templates/list": return ok({ resourceTemplates: [] });
    case "prompts/list": return ok({ prompts: [] });
    case "resources/read": return ok({ contents: [{ uri: WIDGET_URI, mimeType: "text/html+skybridge", text: WIDGET_HTML, _meta: { "openai/widgetPrefersBorder": true } }] });
    default: if (id === undefined) return null; return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } };
  }
}

export default {
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/") return new Response("ok: Vulnerability Explorer MCP at /mcp", { headers: CORS });
    if (!url.pathname.startsWith("/mcp")) return new Response("not found", { status: 404, headers: CORS });
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { ...CORS, Allow: "POST" } });
    let body; try { body = await req.json(); } catch { return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400, headers: CORS }); }
    if (Array.isArray(body)) { const out = (await Promise.all(body.map(rpc))).filter(Boolean); return out.length ? Response.json(out, { headers: CORS }) : new Response(null, { status: 202, headers: CORS }); }
    const res = await rpc(body); if (!res) return new Response(null, { status: 202, headers: CORS });
    return Response.json(res, { headers: CORS });
  },
};

const WIDGET_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#fff;--fg:#111;--mut:#667085;--line:#e4e7ec;--soft:#f5f7fa;--acc:#4f46e5}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#f2f2f2;--mut:#9aa3ad;--line:#2a2f35;--soft:#1c1f24;--acc:#8b85ff}}
*{box-sizing:border-box}body{margin:0;font:13.5px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--fg)}
.w{padding:14px}h1{font-size:17px;margin:0}.sub{color:var(--mut);font-size:12px;margin:2px 0 10px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px}
input,select,button{font:inherit;padding:7px 10px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg)}
input{flex:1;min-width:130px}button.go{background:var(--acc);color:#fff;border:0;cursor:pointer}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}.chip{cursor:pointer;border-radius:999px;padding:5px 11px;font-weight:600;font-size:12px;border:1px solid var(--line);user-select:none;opacity:.45}
.chip.on{opacity:1}.chip b{margin-left:5px}
.CRITICAL{background:#7f1d1d;color:#fff}.HIGH{background:#c2410c;color:#fff}.MEDIUM{background:#ca8a04;color:#fff}.LOW{background:#15803d;color:#fff}.NONE,.KEV{background:#475569;color:#fff}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px}.st{background:var(--soft);border-radius:12px;padding:8px 10px}.st b{display:block;font-size:18px}.st span{color:var(--mut);font-size:11.5px}
.bars{display:flex;align-items:flex-end;gap:3px;height:60px;margin:0 0 10px;padding:0 2px}.bars div{flex:1;border-radius:3px 3px 0 0;background:var(--acc);opacity:.75;min-height:2px;cursor:pointer}.bars div:hover{opacity:1}
.list{display:flex;flex-direction:column;gap:6px;max-height:320px;overflow:auto}
.it{display:flex;gap:10px;align-items:center;padding:8px 10px;border:1px solid var(--line);border-radius:12px;cursor:pointer}.it:hover,.it.sel{border-color:var(--acc);background:var(--soft)}
.sc{min-width:48px;text-align:center;font-weight:700;border-radius:9px;padding:4px 6px}.t{flex:1;min-width:0}.t div{font-weight:600}.t small{color:var(--mut);display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.det{display:none;margin-top:10px;padding:12px;border-radius:12px;background:var(--soft)}.det.on{display:block}.det p{margin:6px 0}.det code{font-size:11.5px;word-break:break-all}a{color:var(--acc)}
.empty{color:var(--mut);text-align:center;padding:20px}
</style></head><body><div class="w">
<h1>🛡️ Vulnerability Explorer</h1><div class="sub" id="sub">Loading live CVE data…</div>
<div class="row"><input id="kw" placeholder="Vendor or product (e.g. microsoft, apache)"><select id="days"><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option></select><button class="go" id="go">Search NVD</button></div>
<div class="chips" id="chips"></div>
<div class="row"><select id="vendor"><option value="">All vendors</option></select><select id="sort"><option value="date">Newest first</option><option value="score">Highest CVSS first</option></select><input id="q" placeholder="Filter results by product or CVE…"></div>
<div class="stats"><div class="st"><b id="sTot">–</b><span>Matching CVEs</span></div><div class="st"><b id="sShow">–</b><span>Shown</span></div><div class="st"><b id="sCrit">–</b><span>Critical</span></div><div class="st"><b id="sAvg">–</b><span>Avg CVSS</span></div></div>
<div class="bars" id="bars" title="CVEs per day (click to filter)"></div>
<div class="list" id="list"></div><div class="det" id="det"></div></div>
<script>
const SEV=['CRITICAL','HIGH','MEDIUM','LOW','NONE','KEV'];let data=null,on=new Set(SEV),day='',sel=null;const $=i=>document.getElementById(i);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function rows(){if(!data)return[];const q=$('q').value.toLowerCase(),v=$('vendor').value;let it=data.items.filter(x=>on.has(x.severity)&&(!v||x.vendor===v)&&(!day||x.published.slice(0,10)===day)&&(!q||(x.id+' '+x.product+' '+x.vendor+' '+x.description).toLowerCase().includes(q)));
if($('sort').value==='score')it.sort((a,b)=>(b.score??-1)-(a.score??-1));else it.sort((a,b)=>b.published.localeCompare(a.published));return it}
function render(){if(!data)return;$('sub').textContent='Source: '+data.source+' · '+(data.keyword?'"'+data.keyword+'" · ':'')+'last '+data.days+' days · fetched '+new Date(data.fetchedAt).toLocaleString();
const cnt={};data.items.forEach(x=>cnt[x.severity]=(cnt[x.severity]||0)+1);$('chips').innerHTML=SEV.filter(s=>cnt[s]).map(s=>'<span class="chip '+s+(on.has(s)?' on':'')+'" data-sev="'+s+'">'+s+'<b>'+cnt[s]+'</b></span>').join('')+(day?'<span class="chip on NONE" data-day="x">'+day+' ✕</span>':'');
const vs=[...new Set(data.items.map(x=>x.vendor))].sort(),cur=$('vendor').value;$('vendor').innerHTML='<option value="">All vendors ('+vs.length+')</option>'+vs.map(v=>'<option'+(v===cur?' selected':'')+'>'+esc(v)+'</option>').join('');
const it=rows(),sc=it.filter(x=>x.score!=null);$('sTot').textContent=data.total;$('sShow').textContent=it.length;$('sCrit').textContent=it.filter(x=>x.severity==='CRITICAL').length;$('sAvg').textContent=sc.length?(sc.reduce((a,x)=>a+x.score,0)/sc.length).toFixed(1):'–';
const per={};data.items.forEach(x=>{const d=x.published.slice(0,10);per[d]=(per[d]||0)+1});const ds=Object.keys(per).sort(),mx=Math.max(1,...Object.values(per));$('bars').innerHTML=ds.map(d=>'<div data-d="'+d+'" style="height:'+(per[d]/mx*100)+'%;'+(day===d?'opacity:1;outline:2px solid var(--fg)':'')+'" title="'+d+': '+per[d]+' CVEs"></div>').join('');
$('list').innerHTML=it.length?it.map(x=>'<div class="it'+(sel===x.id?' sel':'')+'" data-id="'+x.id+'"><span class="sc '+x.severity+'">'+(x.score??x.severity)+'</span><span class="t"><div>'+x.id+' · '+esc(x.vendor)+' '+esc(x.product)+'</div><small>'+x.published.slice(0,10)+' · '+esc(x.description)+'</small></span></div>').join(''):'<div class="empty">No vulnerabilities match these filters</div>'}
function show(id){sel=id;const x=data.items.find(y=>y.id===id);if(!x)return;$('det').className='det on';$('det').innerHTML='<b>'+x.id+'</b> <span class="chip on '+x.severity+'">'+x.severity+(x.score!=null?' · CVSS '+x.score:'')+'</span><p><b>Vendor / product:</b> '+esc(x.vendor)+' / '+esc(x.product)+'<br><b>Published:</b> '+new Date(x.published).toLocaleString()+'</p><p>'+esc(x.description)+'</p>'+(x.vector?'<p><code>'+esc(x.vector)+'</code></p>':'')+'<a href="'+x.url+'" target="_blank" rel="noopener">Open on NVD ↗</a>';render()}
document.addEventListener('click',e=>{const c=e.target.closest('[data-sev]');if(c){const s=c.dataset.sev;on.has(s)?on.delete(s):on.add(s);render();return}const dd=e.target.closest('[data-day]');if(dd){day='';render();return}const b=e.target.closest('[data-d]');if(b){day=day===b.dataset.d?'':b.dataset.d;render();return}const r=e.target.closest('[data-id]');if(r)show(r.dataset.id)});
['q','vendor','sort'].forEach(i=>$(i).addEventListener(i==='q'?'input':'change',render));
async function go(){$('go').textContent='Searching…';try{const r=await window.openai.callTool('search_vulnerabilities',{keyword:$('kw').value,days:+$('days').value});const d=r&&(r.structuredContent||(r.result&&r.result.structuredContent));if(d){data=d;on=new Set(SEV);day='';sel=null;$('det').className='det';$('vendor').value=''}}catch(e){}$('go').textContent='Search NVD';render()}
$('go').addEventListener('click',go);$('kw').addEventListener('keydown',e=>{if(e.key==='Enter')go()});
function load(){const o=window.openai&&window.openai.toolOutput;if(o&&o.items){data=o;$('kw').value=o.keyword||'';$('days').value=String(o.days>60?90:o.days>10?30:7);render()}}
window.addEventListener('openai:set_globals',load);load();
</script></body></html>`;
