# Athena Live Data Agent

An Athena AI agent that fetches **real, live public data** through an **MCP server** and renders it in an **embedded interactive widget** inside the Athena chat.

## How it works

- `worker.js` is a single-file **Cloudflare Worker** that implements an MCP server over **Streamable HTTP** (stateless JSON-RPC) at `/mcp`.
- It exposes one tool, `explore_data`, which fetches live data from a public source and returns it as `structuredContent`.
- The tool's `_meta["openai/outputTemplate"]` points to a widget resource `ui://widget/explorer.html` served with the `text/html+skybridge` MIME type, so Athena renders it inside the chat.
- The widget reads `window.openai.toolOutput`, and is interactive: live filter, sorting, a bar chart, clickable rows with a details panel, and a **Refresh live data** button that calls the tool again through `window.openai.callTool`. UI state is kept with `window.openai.setWidgetState`.

## MCP methods implemented

`initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`, `resources/read`, `resources/templates/list`, `prompts/list` (plus CORS for browser clients).

## Deploy

1. Create a Cloudflare Worker and paste `worker.js` (no build step or dependencies).
2. Deploy. The MCP endpoint is `https://<worker>.workers.dev/mcp`.
3. In Athena: **Create Chat Agent → Capabilities → MCP Server URL**, paste the endpoint, publish.

## Test locally

```bash
npx @modelcontextprotocol/inspector@latest --server-url https://<worker>.workers.dev/mcp --transport http
```

## Author

Hassan Khachab · hello@hassankhachab.dev · https://hassankhachab.dev
