# CVE Vulnerability Explorer (Athena AI agent)

Explore real, live cybersecurity vulnerabilities by **vendor, product, severity and publication date** inside an Athena chat, through an **MCP server** and an **embedded interactive widget**.

- Agent: https://athenachat.bot/chatbot/agent/live-data-explorer7442
- MCP endpoint: https://athena-mcp.hassankhachab999.workers.dev/mcp

## Data source

- **NIST National Vulnerability Database (NVD) CVE API 2.0**, which is public and needs no key. It is queried live with `keywordSearch`, `cvssV3Severity`, `pubStartDate` and `pubEndDate`, and the newest page is returned.
- If NVD is unavailable, the server falls back to the **CISA Known Exploited Vulnerabilities** catalog.

## MCP server (`worker.js`)

`worker.js` is a single-file Cloudflare Worker with no dependencies. It implements MCP over Streamable HTTP (stateless JSON-RPC) at `/mcp`.

- Tool **`search_vulnerabilities`** takes `{ keyword, severity, days, limit }`.
  - It returns `structuredContent` with the CVE list: id, vendor and product (parsed from CPE, or taken from the CNA as a fallback), CVSS score, severity, vector, published date, description and NVD link.
  - It also returns a text summary for the model.
- The tool's `_meta["openai/outputTemplate"]` points to the widget resource `ui://widget/vuln-explorer.html` (`text/html+skybridge`).
- Methods: `initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`, `resources/read`, `resources/templates/list`, `prompts/list`. CORS is enabled.

## Widget interactions

1. **Severity chips** (CRITICAL / HIGH / MEDIUM / LOW) with counts. Click a chip to toggle it.
2. **Vendor dropdown**, built from the results, plus a free-text filter for product or CVE ID.
3. **Publication-date bar chart** showing CVEs per day. Click a bar to filter to that day.
4. **Sort** by newest first or by highest CVSS first.
5. **Click a CVE** to open a details panel with the description, CVSS vector and NVD link.
6. **Live re-query:** change the vendor/product keyword and the time window, then press *Search NVD*. This calls the MCP tool again through `window.openai.callTool`.

The stats tiles (matching, shown, critical and average CVSS) update with every filter.

## Deploy

1. Create a Cloudflare Worker, paste `worker.js` and deploy.
2. In Athena, go to **Create Chat Agent → Capabilities → MCP Server URL**, enter `https://<worker>.workers.dev/mcp`, then publish.

## Author

Hassan Khachab · hello@hassankhachab.dev · https://hassankhachab.dev
