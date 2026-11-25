// Athena AI agent MCP server — single-file Cloudflare Worker (no npm needed).
// Stateless Streamable HTTP (JSON responses). Endpoint: https://<worker>.workers.dev/mcp
// TO ADAPT TO THE SUBJECT: edit SUBJECT + fetchData() only.

const SUBJECT = {
  name: "Earthquakes",                       // shown in widget title
  tool: "explore_data",
  toolTitle: "Explore live earthquake data",
  description: "Fetches real, live data about recent earthquakes worldwide from the public USGS feed and shows it in an interactive widget. Use for any question about recent earthquakes, magnitudes or places.",
  source: "USGS Earthquake Hazards Program (earthquake.usgs.gov)",
};

// Must return [{ title, subtitle, value, valueLabel, url, lat, lon, details:{k:v} }]
async function fetchData(query, limit) {
  const r = await fetch("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson", { headers: { "user-agent": "athena-agent" } });
  const j = await r.json();
  let items = j.features.map(f => ({
    title: f.properties.place || "Unknown place",
    subtitle: new Date(f.properties.time).toUTCString(),
    value: f.properties.mag,
    valueLabel: "Magnitude",
    url: f.properties.url,
    lat: f.geometry.coordinates[1],
    lon: f.geometry.coordinates[0],
    details: { "Depth (km)": f.geometry.coordinates[2], "Type": f.properties.type, "Tsunami": f.properties.tsunami ? "Yes" : "No", "Felt reports": f.properties.felt ?? 0 },
  }));
  if (query) { const q = query.toLowerCase(); items = items.filter(i => (i.title + " " + i.subtitle).toLowerCase().includes(q)); }
  items.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  return items.slice(0, limit || 50);
}

// ---------------- generic MCP plumbing (no need to edit) ----------------
const WIDGET_URI = "ui://widget/explorer.html";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "content-type, mcp-session-id, mcp-protocol-version, authorization",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};
const TOOL = {
  name: SUBJECT.tool,
  title: SUBJECT.toolTitle,
  description: SUBJECT.description,
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Optional keyword filter (place, name, etc.)" },
      limit: { type: "number", description: "Max results (default 50)" },
    },
  },
  _meta: {
    "openai/outputTemplate": WIDGET_URI,
    "openai/widgetAccessible": true,
    "openai/toolInvocation/invoking": "Fetching live data…",
    "openai/toolInvocation/invoked": "Data loaded",
  },
};

async function callTool(args) {
  const items = await fetchData(args?.query || "", args?.limit || 50);
  const data = { subject: SUBJECT.name, source: SUBJECT.source, query: args?.query || "", fetchedAt: new Date().toISOString(), count: items.length, items };
  const top = items.slice(0, 5).map(i => `${i.title} (${i.valueLabel} ${i.value})`).join("; ");
  return {
    structuredContent: data,
    content: [{ type: "text", text: `Fetched ${items.length} live ${SUBJECT.name} records from ${SUBJECT.source}. Top: ${top}` }],
    _meta: { "openai/outputTemplate": WIDGET_URI },
  };
}

async function rpc(msg) {
  const { id, method, params } = msg;
  const ok = result => ({ jsonrpc: "2.0", id, result });
  switch (method) {
    case "initialize":
      return ok({ protocolVersion: params?.protocolVersion || "2025-06-18", capabilities: { tools: { listChanged: false }, resources: { listChanged: false } }, serverInfo: { name: "athena-explorer", version: "1.0.0" } });
    case "ping": return ok({});
    case "tools/list": return ok({ tools: [TOOL] });
    case "tools/call":
      if (params?.name !== SUBJECT.tool) return { jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown tool" } };
      try { return ok(await callTool(params.arguments || {})); }
      catch (e) { return ok({ isError: true, content: [{ type: "text", text: "Data source error: " + e.message }] }); }
    case "resources/list":
      return ok({ resources: [{ uri: WIDGET_URI, name: "explorer-widget", mimeType: "text/html+skybridge" }] });
    case "resources/templates/list": return ok({ resourceTemplates: [] });
    case "prompts/list": return ok({ prompts: [] });
    case "resources/read":
      return ok({ contents: [{ uri: WIDGET_URI, mimeType: "text/html+skybridge", text: WIDGET_HTML, _meta: { "openai/widgetPrefersBorder": true } }] });
    default:
      if (id === undefined) return null; // notification
      return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } };
  }
}

export default {
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/" ) return new Response("ok: MCP at /mcp", { headers: CORS });
    if (!url.pathname.startsWith("/mcp")) return new Response("not found", { status: 404, headers: CORS });
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { ...CORS, Allow: "POST" } });
    let body; try { body = await req.json(); } catch { return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400, headers: CORS }); }
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map(rpc))).filter(Boolean);
      return out.length ? Response.json(out, { headers: CORS }) : new Response(null, { status: 202, headers: CORS });
    }
    const res = await rpc(body);
    if (!res) return new Response(null, { status: 202, headers: CORS });
    return Response.json(res, { headers: CORS });
  },
};

// ---------------- widget (generic, interactive) ----------------
const WIDGET_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#fff;--fg:#111;--mut:#667085;--line:#e4e7ec;--acc:#0f8f78;--soft:#f2f7f6}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#f2f2f2;--mut:#9aa3ad;--line:#2a2f35;--acc:#3fd6b0;--soft:#1b2523}}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--fg)}
.wrap{padding:14px}h1{font-size:17px;margin:0 0 2px}.sub{color:var(--mut);font-size:12px;margin-bottom:10px}
.bar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}input,select,button{font:inherit;padding:7px 10px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg)}
input{flex:1;min-width:140px}button{background:var(--acc);color:#fff;border:0;cursor:pointer}button.ghost{background:transparent;color:var(--fg);border:1px solid var(--line)}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px}.stat{background:var(--soft);border-radius:12px;padding:8px 10px}.stat b{display:block;font-size:18px}.stat span{color:var(--mut);font-size:12px}
svg{width:100%;height:90px;display:block;margin-bottom:8px}
.list{display:flex;flex-direction:column;gap:6px;max-height:330px;overflow:auto}
.it{display:flex;align-items:center;gap:10px;padding:9px 10px;border:1px solid var(--line);border-radius:12px;cursor:pointer}
.it:hover,.it.sel{border-color:var(--acc);background:var(--soft)}.v{min-width:52px;text-align:center;font-weight:700;color:#fff;border-radius:9px;padding:4px 6px}
.t{flex:1;min-width:0}.t div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.t small{color:var(--mut)}
.det{margin-top:10px;padding:10px;border-radius:12px;background:var(--soft);display:none}.det.on{display:block}.det table{width:100%;border-collapse:collapse}.det td{padding:3px 0;border-bottom:1px solid var(--line)}.det td:last-child{text-align:right}
a{color:var(--acc)}.empty{color:var(--mut);padding:20px;text-align:center}
</style></head><body><div class="wrap">
<h1 id="h">Loading…</h1><div class="sub" id="s"></div>
<div class="bar"><input id="q" placeholder="Filter…"><select id="sort"><option value="v">Highest value</option><option value="vl">Lowest value</option><option value="t">A–Z</option></select><button id="rf">Refresh live data</button></div>
<div class="stats"><div class="stat"><b id="c">–</b><span>Records</span></div><div class="stat"><b id="mx">–</b><span id="mxl">Max</span></div><div class="stat"><b id="av">–</b><span>Average</span></div></div>
<svg id="ch" viewBox="0 0 600 90" preserveAspectRatio="none"></svg>
<div class="list" id="l"></div><div class="det" id="d"></div></div>
<script>
let data=null,sel=-1;const $=id=>document.getElementById(id);
const st=window.openai&&window.openai.widgetState||{};$('q').value=st.q||'';$('sort').value=st.sort||'v';
function col(v,mx){const t=mx?Math.min(1,(v||0)/mx):0;return 'hsl('+(160-160*t)+' 65% '+(42-8*t)+'%)'}
function save(){try{window.openai&&window.openai.setWidgetState({q:$('q').value,sort:$('sort').value})}catch(e){}}
function view(){if(!data)return;const q=$('q').value.toLowerCase();let it=data.items.map((x,i)=>({...x,i})).filter(x=>(x.title+' '+x.subtitle).toLowerCase().includes(q));
const s=$('sort').value;it.sort((a,b)=>s==='v'?(b.value??0)-(a.value??0):s==='vl'?(a.value??0)-(b.value??0):a.title.localeCompare(b.title));
$('h').textContent='Live '+data.subject;$('s').innerHTML='Source: '+data.source+' · fetched '+new Date(data.fetchedAt).toLocaleString();
const vs=it.map(x=>+x.value||0),mx=Math.max(0,...vs);$('c').textContent=it.length;$('mx').textContent=vs.length?mx.toFixed(1):'–';$('mxl').textContent='Max '+(it[0]&&it[0].valueLabel||'');$('av').textContent=vs.length?(vs.reduce((a,b)=>a+b,0)/vs.length).toFixed(2):'–';
const w=600/Math.max(1,it.length);$('ch').innerHTML=it.map((x,k)=>'<rect x="'+(k*w+1)+'" y="'+(90-((+x.value||0)/(mx||1))*86)+'" width="'+Math.max(1,w-2)+'" height="'+(((+x.value||0)/(mx||1))*86)+'" rx="2" fill="'+col(x.value,mx)+'" data-i="'+x.i+'"><title>'+x.title+': '+x.value+'</title></rect>').join('');
$('l').innerHTML=it.length?it.map(x=>'<div class="it'+(x.i===sel?' sel':'')+'" data-i="'+x.i+'"><span class="v" style="background:'+col(x.value,mx)+'">'+(x.value??'–')+'</span><span class="t"><div>'+x.title+'</div><small>'+x.subtitle+'</small></span></div>').join(''):'<div class="empty">No matches</div>';}
function det(i){sel=i;const x=data.items[i];if(!x)return;$('d').className='det on';$('d').innerHTML='<b>'+x.title+'</b><table>'+'<tr><td>'+x.valueLabel+'</td><td>'+x.value+'</td></tr>'+Object.entries(x.details||{}).map(([k,v])=>'<tr><td>'+k+'</td><td>'+v+'</td></tr>').join('')+(x.lat!=null?'<tr><td>Location</td><td>'+(+x.lat).toFixed(2)+', '+(+x.lon).toFixed(2)+'</td></tr>':'')+'</table>'+(x.url?'<p><a href="'+x.url+'" target="_blank" rel="noopener">Open source record ↗</a></p>':'');view()}
document.addEventListener('click',e=>{const t=e.target.closest('[data-i]');if(t)det(+t.dataset.i)});
$('q').addEventListener('input',()=>{save();view()});$('sort').addEventListener('change',()=>{save();view()});
$('rf').addEventListener('click',async()=>{$('rf').textContent='Loading…';try{const r=await window.openai.callTool(${JSON.stringify(SUBJECT.tool)},{query:''});const d=r&&(r.structuredContent||r.result&&r.result.structuredContent);if(d){data=d;sel=-1;$('d').className='det'}}catch(e){}$('rf').textContent='Refresh live data';view()});
function load(){const o=window.openai&&window.openai.toolOutput;if(o&&o.items){data=o;view()}}
window.addEventListener('openai:set_globals',load);load();
</script></body></html>`;
