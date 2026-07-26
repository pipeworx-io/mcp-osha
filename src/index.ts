interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * OSHA MCP — US workplace-safety standards (29 CFR Chapter XVII, parts 1900–1990).
 *
 * OSHA standards ARE US federal regulations codified in 29 CFR. Agents search
 * "OSHA standard for fall protection", never "eCFR title 29" — so this is a
 * thin, OSHA-branded, keyless wrapper over the official eCFR API
 * (www.ecfr.gov/api), scoped to the OSHA parts of Title 29 (Labor):
 * 1902, 1903, 1904, 1910 (general industry), 1915/1917/1918 (maritime),
 * 1926 (construction), 1928 (agriculture), 1960, etc. Wage/hour parts of
 * Title 29 (< 1900) are filtered out — they are Dept. of Labor, not OSHA.
 *
 * Tools:
 * - osha_standard: full text of one OSHA standard by citation (e.g. "1910.132")
 * - osha_search:   keyword search across OSHA standards ("fall protection")
 *
 * Self-contained: does NOT import the eCFR pack — calls the eCFR API directly.
 */


const BASE = 'https://www.ecfr.gov/api';
const UA = 'pipeworx/1.0 (+https://pipeworx.io)';
const TITLE = 29;

// --- OSHA part range: 29 CFR Chapter XVII is parts 1900–1990. Title-29 parts
// below 1900 are wage/hour (Wage & Hour Division), not OSHA — excluded.
const OSHA_PART_MIN = 1900;
const OSHA_PART_MAX = 1990;
function isOshaPart(part: string | number | null | undefined): boolean {
  const n = Number(part);
  return Number.isInteger(n) && n >= OSHA_PART_MIN && n <= OSHA_PART_MAX;
}

// --- XML/entity helpers (same approach as the eCFR pack) ---------------------
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripHtml(s: unknown): string {
  if (typeof s !== 'string') return '';
  return decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

// Convert an eCFR content XML fragment to readable text: drop the <HEAD>
// (returned separately), turn block closers into line breaks, strip tags,
// decode entities — preserving paragraph structure.
function xmlToText(xml: string): string {
  return decodeEntities(
    xml
      .replace(/<\?xml[^>]*\?>/g, '')
      .replace(/<HEAD>[\s\S]*?<\/HEAD>/g, '')
      .replace(/<\/(P|FP|HEAD|DIV\d+)>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

// --- eCFR fetch with per-attempt timeout + 503 retry (the /full/ endpoint
// intermittently 503s / hangs under load). A timeout is treated like a 503.
async function ecfrOnce(path: string, accept: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(`${BASE}${path}`, {
      headers: { Accept: accept, 'User-Agent': UA },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function ecfrFetch(path: string, accept: string, retries = 3): Promise<Response> {
  let res: Response | null = null;
  for (let i = 0; i < retries; i++) {
    try {
      res = await ecfrOnce(path, accept, 12000);
      if (res.status !== 503) return res;
    } catch {
      res = null; // aborted (timeout) or network error — retry
    }
    if (i < retries - 1) await new Promise((r) => setTimeout(r, 600 * (i + 1)));
  }
  if (res) return res;
  throw new Error(
    'eCFR temporarily unavailable (the OSHA/eCFR text endpoint is timing out — retry in a few seconds).',
  );
}

async function ecfrGet(path: string): Promise<Record<string, unknown>> {
  const res = await ecfrFetch(path, 'application/json');
  if (!res.ok) throw new Error(`eCFR: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as Record<string, unknown>;
}

// Current currency date for Title 29, with a 7-day-ago fallback.
async function currentDate(): Promise<string> {
  try {
    const data = await ecfrGet('/versioner/v1/titles.json');
    const titles = Array.isArray(data.titles) ? (data.titles as Array<Record<string, unknown>>) : [];
    const t = titles.find((x) => Number(x.number) === TITLE);
    if (t && typeof t.up_to_date_as_of === 'string' && t.up_to_date_as_of) return t.up_to_date_as_of;
  } catch {
    /* fall through to date fallback */
  }
  return new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
}

// --- citation parsing --------------------------------------------------------
// Forgiving: "1910.132", "29 CFR 1910.132", "§1910.132", "1910.132(a)",
// "1926 subpart M", "1910". Returns the section (part.section) or a bare part.
function parseCitation(raw: string): { section: string | null; part: string | null; subpartHint: string | null } {
  let s = raw.trim();
  // strip leading "29 CFR", "CFR", section sign, whitespace
  s = s.replace(/^29\s*cfr\s*/i, '').replace(/^cfr\s*/i, '').replace(/§+/g, '').trim();
  // detect an explicit subpart mention (e.g. "1926 subpart M")
  const subMatch = s.match(/subpart\s+([A-Za-z]+)/i);
  const subpartHint = subMatch ? subMatch[1].toUpperCase() : null;
  if (subMatch) s = s.slice(0, subMatch.index).trim();
  // a full section like 1910.132 (optionally with paragraph "(a)", "-1", etc.)
  const secMatch = s.match(/(\d{3,4})\.(\d+[A-Za-z]*)/);
  if (secMatch) {
    return { section: `${secMatch[1]}.${secMatch[2]}`, part: secMatch[1], subpartHint };
  }
  // a bare part like "1910" or "1926"
  const partMatch = s.match(/\b(\d{3,4})\b/);
  if (partMatch) return { section: null, part: partMatch[1], subpartHint };
  return { section: null, part: null, subpartHint };
}

// Best-effort subpart lookup for a section, via the eCFR search hierarchy
// (which carries `subpart`). Wrapped so a miss never fails the main call.
async function lookupSubpart(section: string): Promise<string | null> {
  try {
    const params = new URLSearchParams({ query: section, per_page: '5', order: 'relevance' });
    params.append('hierarchy[title]', String(TITLE));
    const data = await ecfrGet(`/search/v1/results?${params.toString()}`);
    const results = Array.isArray(data.results) ? (data.results as Array<Record<string, unknown>>) : [];
    for (const r of results) {
      const h = (r.hierarchy as Record<string, unknown> | undefined) ?? {};
      if (h.section != null && String(h.section) === section && h.subpart != null) {
        return String(h.subpart);
      }
    }
  } catch {
    /* ignore — subpart is optional metadata */
  }
  return null;
}

// --- tools -------------------------------------------------------------------
const tools: McpToolExport['tools'] = [
  {
    name: 'osha_standard',
    description:
      'Get the full text of one OSHA standard (US workplace-safety / occupational safety and health regulation) by its citation. OSHA standards are 29 CFR — this returns the exact regulatory wording currently in force. Answers "what is the OSHA standard for X", "does OSHA require X", "read the text of 1910.132", "the OSHA fall protection rule". Forgiving citation input: "1910.132", "29 CFR 1910.132", "§1910.132", "1926.501", even "1910.132(a)" (paragraph is stripped to the section). Covers 29 CFR 1910 general industry, 1926 construction, 1915/1917/1918 maritime, 1928 agriculture, plus recordkeeping (1904) and PPE / hazard communication / lockout tagout / respiratory protection / confined space / bloodborne pathogens standards. Pass a whole part (e.g. "1910" or "1926") to get that part\'s section list instead. Example: osha_standard({ citation: "1910.132" }) → PPE general requirements; osha_standard({ citation: "1926.501" }) → construction fall protection. Keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        citation: {
          type: 'string',
          description:
            'OSHA standard citation. A section: "1910.132", "29 CFR 1910.1200", "§1910.147", "1926.501", "1910.132(a)". Or a whole part: "1910", "1926", "1926 subpart M" → returns the part\'s section list.',
        },
      },
      required: ['citation'],
    },
  },
  {
    name: 'osha_search',
    description:
      'Keyword search across OSHA standards — the US workplace-safety / occupational safety and health regulations in 29 CFR (parts 1900–1990). Answers "what OSHA standards cover X", "OSHA regulation / workplace safety requirement for X", "find the OSHA rule about X". Great for topics: fall protection, hazard communication (HazCom / GHS), lockout tagout (LOTO), respiratory protection, personal protective equipment (PPE), confined space, bloodborne pathogens, machine guarding, scaffolding, excavation, permissible exposure limits, recordkeeping. Returns matching OSHA standards with citation, heading, excerpt, and source URL. Results are filtered to OSHA parts only (1910 general industry, 1926 construction, 1915/1917/1918 maritime, 1928 agriculture, 1904 recordkeeping, etc.) — Title-29 wage/hour parts are excluded. Example: osha_search({ query: "fall protection" }); osha_search({ query: "lockout tagout", limit: 15 }). Keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'Workplace-safety topic or phrase, e.g. "fall protection", "hazard communication", "lockout tagout", "respiratory protection", "PPE", "confined space", "bloodborne pathogens".',
        },
        limit: { type: 'number', description: 'Max results to return, 1–20 (default 10).' },
      },
      required: ['query'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'osha_standard':
        return oshaStandard(args);
      case 'osha_search':
        return oshaSearch(args);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function oshaStandard(args: Record<string, unknown>): Promise<unknown> {
  const raw = typeof args.citation === 'string' ? args.citation : '';
  if (!raw.trim()) return { error: 'provide a citation, e.g. "1910.132" or "29 CFR 1926.501"' };

  const { section, part, subpartHint } = parseCitation(raw);
  if (!part) {
    return {
      error: `Could not parse an OSHA citation from "${raw}". Use a section like "1910.132" or "29 CFR 1926.501", or a part like "1910".`,
    };
  }
  if (!isOshaPart(part)) {
    return {
      error: `29 CFR part ${part} is not an OSHA standard. OSHA is 29 CFR parts ${OSHA_PART_MIN}–${OSHA_PART_MAX} (e.g. 1910 general industry, 1926 construction). Part ${part} is a non-OSHA (e.g. wage/hour) part of Title 29.`,
      part,
    };
  }

  const date = await currentDate();

  // ---- whole part requested: return its section list -----------------------
  if (!section) {
    const res = await ecfrFetch(
      `/versioner/v1/full/${date}/title-${TITLE}.xml?part=${encodeURIComponent(part)}`,
      'application/xml',
    );
    if (res.status === 404) {
      return { error: `29 CFR part ${part} not found as of ${date}.`, part, date };
    }
    if (res.status === 503) {
      return { error: 'eCFR temporarily unavailable — retry in a few seconds.', part };
    }
    if (!res.ok) throw new Error(`eCFR: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const xml = await res.text();
    const blocks = xml.split(/<DIV8\b/).slice(1);
    const sections = blocks
      .map((b) => {
        const n = b.match(/\bN="([^"]+)"/)?.[1] ?? null;
        const head = b.match(/<HEAD>([\s\S]*?)<\/HEAD>/);
        return { section: n, heading: head ? stripHtml(head[1]) : null };
      })
      .filter((s) => s.section);
    return {
      part,
      citation: `29 CFR Part ${part}`,
      date,
      source: 'eCFR / OSHA 29 CFR',
      source_url: `https://www.ecfr.gov/current/title-29/part-${part}`,
      section_count: sections.length,
      note: `This is a whole OSHA part (${sections.length} sections). Call osha_standard with a specific citation (e.g. "${sections[0]?.section ?? part + '.1'}") to get full text.`,
      sections,
    };
  }

  // ---- single section ------------------------------------------------------
  const res = await ecfrFetch(
    `/versioner/v1/full/${date}/title-${TITLE}.xml?part=${encodeURIComponent(part)}&section=${encodeURIComponent(section)}`,
    'application/xml',
  );
  if (res.status === 404) {
    return {
      error: `OSHA standard 29 CFR ${section} not found as of ${date}. Check the citation, or use osha_search to find it.`,
      citation: `29 CFR ${section}`,
      part,
      date,
    };
  }
  if (res.status === 503) {
    return { error: 'eCFR temporarily unavailable — retry in a few seconds.', citation: `29 CFR ${section}` };
  }
  if (!res.ok) throw new Error(`eCFR: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const xml = await res.text();

  const headMatch = xml.match(/<HEAD>([\s\S]*?)<\/HEAD>/);
  const heading = headMatch ? stripHtml(headMatch[1]) : null;
  const full = xmlToText(xml);
  const CAP = 30000;
  const truncated = full.length > CAP;

  // subpart: use the "1926 subpart M" hint if given, else best-effort lookup.
  const subpart = subpartHint ?? (await lookupSubpart(section));

  return {
    citation: `29 CFR ${section}`,
    part,
    subpart: subpart ?? null,
    heading,
    text: truncated ? full.slice(0, CAP) : full,
    truncated,
    date,
    source: 'eCFR / OSHA 29 CFR',
    source_url: `https://www.ecfr.gov/current/title-29/section-${section}`,
  };
}

async function oshaSearch(args: Record<string, unknown>): Promise<unknown> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) return { error: 'provide a query, e.g. "fall protection" or "lockout tagout"' };

  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 20);

  // eCFR search returns one row per matching PARAGRAPH, so a single dense
  // section can fill an entire page. Dedupe by citation AND drop non-OSHA
  // (Title-29 wage/hour) parts, walking up to 3 pages (20/page, the API max)
  // until `limit` distinct OSHA sections are collected.
  const seen = new Set<string>();
  const results: Array<Record<string, unknown>> = [];
  let total: unknown = null;

  for (let page = 1; page <= 3 && results.length < limit; page++) {
    const params = new URLSearchParams({
      query,
      per_page: '20',
      page: String(page),
      order: 'relevance',
    });
    params.append('hierarchy[title]', String(TITLE));

    const data = await ecfrGet(`/search/v1/results?${params.toString()}`);
    const meta = (data.meta as Record<string, unknown> | undefined) ?? {};
    if (total == null) total = meta.total_count ?? null;
    const rawResults = Array.isArray(data.results) ? (data.results as Array<Record<string, unknown>>) : [];
    if (rawResults.length === 0) break;

    for (const r of rawResults) {
      if (results.length >= limit) break;
      const h = (r.hierarchy as Record<string, unknown> | undefined) ?? {};
      const headings = (r.headings as Record<string, unknown> | undefined) ?? {};
      const hHeadings = (r.hierarchy_headings as Record<string, unknown> | undefined) ?? {};
      const part = h.part != null ? String(h.part) : null;
      const section = h.section != null ? String(h.section) : null;
      const subpart = h.subpart != null ? String(h.subpart) : null;
      // OSHA-only: keep parts 1900–1990, drop Title-29 wage/hour and unparseable.
      if (!isOshaPart(part)) continue;
      const heading =
        (typeof headings.section === 'string' && stripHtml(headings.section)) ||
        (typeof hHeadings.section === 'string' && stripHtml(hHeadings.section)) ||
        null;
      let citation: string;
      let source_url: string;
      if (section) {
        citation = `29 CFR ${section}`;
        source_url = `https://www.ecfr.gov/current/title-29/section-${section}`;
      } else if (part) {
        citation = `29 CFR Part ${part}`;
        source_url = `https://www.ecfr.gov/current/title-29/part-${part}`;
      } else {
        continue;
      }
      if (seen.has(citation)) continue;
      seen.add(citation);
      results.push({
        part,
        subpart,
        section,
        citation,
        heading,
        excerpt: stripHtml(r.full_text_excerpt ?? (r as Record<string, unknown>).excerpt).slice(0, 300),
        source_url,
      });
    }
  }

  return {
    query,
    total_matches: total,
    count: results.length,
    scope: 'OSHA standards — 29 CFR parts 1900–1990 (Chapter XVII)',
    source: 'eCFR / OSHA 29 CFR',
    results,
  };
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
