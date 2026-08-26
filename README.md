# mcp-osha

OSHA MCP — US workplace-safety standards (29 CFR Chapter XVII, parts 1900–1990).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `osha_standard` | Get the full text of one OSHA standard (US workplace-safety / occupational safety and health regulation) by its citation. OSHA standards are 29 CFR — this returns the exact regulatory wording currently in force. Answers "what is the OSHA standard for X", "does OSHA require X", "read the text of 1910.132", "the OSHA fall protection rule". Forgiving citation input: "1910.132", "29 CFR 1910.132", "§1910.132", "1926.501", even "1910.132(a)" (paragraph is stripped to the section). Covers 29 CFR 1910 general industry, 1926 construction, 1915/1917/1918 maritime, 1928 agriculture, plus recordkeeping (1904) and PPE / hazard communication / lockout tagout / respiratory protection / confined space / bloodborne pathogens standards. Pass a whole part (e.g. "1910" or "1926") to get that part's section list instead. Example: osha_standard({ citation: "1910.132" }) → PPE general requirements; osha_standard({ citation: "1926.501" }) → construction fall protection. Keyless. |
| `osha_search` | Keyword search across OSHA standards — the US workplace-safety / occupational safety and health regulations in 29 CFR (parts 1900–1990). Answers "what OSHA standards cover X", "OSHA regulation / workplace safety requirement for X", "find the OSHA rule about X". Great for topics: fall protection, hazard communication (HazCom / GHS), lockout tagout (LOTO), respiratory protection, personal protective equipment (PPE), confined space, bloodborne pathogens, machine guarding, scaffolding, excavation, permissible exposure limits, recordkeeping. Returns matching OSHA standards with citation, heading, excerpt, and source URL. Results are filtered to OSHA parts only (1910 general industry, 1926 construction, 1915/1917/1918 maritime, 1928 agriculture, 1904 recordkeeping, etc.) — Title-29 wage/hour parts are excluded. Example: osha_search({ query: "fall protection" }); osha_search({ query: "lockout tagout", limit: 15 }). Keyless. |

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

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

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
