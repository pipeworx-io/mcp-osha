# @pipeworx/osha

US OSHA workplace-safety standards (29 CFR) AND OSHA enforcement records —
inspections, violations, and penalties by establishment.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `osha_standard(citation)` — full text of one OSHA standard by citation (e.g. "1910.132"), or a part's section list.
- `osha_search(query, limit?)` — keyword search across OSHA standards (29 CFR parts 1900–1990).
- `osha_inspections(establishment?, state?, since?, limit?)` — OSHA inspections for a named establishment and/or state, with dates, inspection type, scope, and open/closed status.
- `osha_inspection(activity_nr)` — one inspection's violations: standard cited, violation type, instances, employees exposed, and initial + current penalty amounts, with totals.
- `osha_establishment_summary(name, state?)` — rolled-up inspection count, violation count, total penalties, last inspection date, and the distinct establishment names matched.

## Auth

- `osha_standard` / `osha_search`: keyless (eCFR).
- `osha_inspections` / `osha_inspection` / `osha_establishment_summary`: platform key
  (`PLATFORM_DOL_KEY`) with BYO override via `_apiKey` — the same key and the
  same DOL Open Data Portal account the `dol-whd` pack uses.

## Data sources

- <https://www.ecfr.gov/api> — eCFR, for the standards tools.
- <https://apiprod.dol.gov/v4/get/osha/inspection/json> — OSHA Inspection (DOL dataset 10334).
- <https://apiprod.dol.gov/v4/get/osha/violation/json> — OSHA Violation (DOL dataset 10338).

Both enforcement tables are called live, per request — **no stored copy**.
Measured 2026-10-09/10 against the live API:

- The HTML establishment-search UI the original task named
  (`osha.gov/pls|ords/imis/establishment.search`) sits behind an AWS WAF
  "Human Verification" CAPTCHA on every request — `HTTP 405`,
  `x-amzn-waf-action: captcha` — even from a plain curl with a full browser
  User-Agent. That is a JS/CAPTCHA challenge, not a UA check, so no
  server-side fetch (including a Cloudflare Worker) can pass it. It is not
  used by this pack.
- `enforcedata.dol.gov` 301-redirects to `data.dol.gov`, the same React SPA
  host `dol-whd` already reverse-engineered. Its real API —
  `apiprod.dol.gov/v4` — serves OSHA's inspection and violation tables
  live and per-request, filterable by `filter_object`, not as a bulk-download
  catalog. Frequency is "Daily"; a live violation row's `load_dt` was the day
  before this was built. No baking, no KV/D1, no database — this reuses
  `dol-whd`'s already-funded platform key.
- Row access repeats two `dol-whd` findings: the `/v4/get/...` endpoint
  REJECTS the key as an `X-API-KEY` HEADER (401) and requires it as a QUERY
  PARAMETER instead; a zero-match query answers `HTTP 204` with an EMPTY
  body, not `{"data":[]}`.
- NEW, not documented anywhere DOL publishes: `like` matching on `estab_name`
  is CASE-SENSITIVE and the column is stored UPPER-CASE — `%walmart%` 204s,
  `%WALMART%` 200s for the identical establishment. Every name/establishment
  argument is upper-cased before building the filter.
- The ~20-call/10-minute 429 throttle `dol-whd` documented is shared by this
  dataset (hit it live while building this pack). On 429, each enforcement
  tool backs off twice, then returns `reason: 'upstream_rate_limited'`
  rather than a bare throw or a silent `found:false`.
- `data_as_of` on every enforcement response is the call's own timestamp —
  there is no cache to report a load date for; the request IS the read.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "osha": {
      "url": "https://gateway.pipeworx.io/osha/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/osha/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/osha_standard \
  -H 'Content-Type: application/json' \
  -d '{"citation":"1910.132"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/osha_standard`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-osha` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/osha/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "osha": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-osha"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Osha data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
