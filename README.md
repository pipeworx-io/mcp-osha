# mcp-osha

OSHA MCP — US workplace-safety standards (29 CFR Chapter XVII, parts 1900–1990).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

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

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Osha data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
