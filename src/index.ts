interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities$shared(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities$shared(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * OSHA MCP — US workplace-safety standards (29 CFR Chapter XVII, parts 1900–1990)
 * AND OSHA enforcement records (inspections / violations / penalties).
 *
 * OSHA standards ARE US federal regulations codified in 29 CFR. Agents search
 * "OSHA standard for fall protection", never "eCFR title 29" — so the first
 * two tools are a thin, OSHA-branded, keyless wrapper over the official eCFR
 * API (www.ecfr.gov/api), scoped to the OSHA parts of Title 29 (Labor):
 * 1902, 1903, 1904, 1910 (general industry), 1915/1917/1918 (maritime),
 * 1926 (construction), 1928 (agriculture), 1960, etc. Wage/hour parts of
 * Title 29 (< 1900) are filtered out — they are Dept. of Labor, not OSHA.
 *
 * Tools:
 * - osha_standard:             full text of one OSHA standard by citation (e.g. "1910.132")
 * - osha_search:                keyword search across OSHA standards ("fall protection")
 * - osha_inspections:           inspections by establishment name / state / since-date
 * - osha_inspection:             one inspection's violations, standards cited, penalties
 * - osha_establishment_summary: inspection + penalty totals for an establishment
 *
 * Self-contained: does NOT import the eCFR pack — calls the eCFR API directly.
 *
 * ── ENFORCEMENT TOOLS (fleet #2842) — PROXY, not a stored copy ─────────────
 * The task that opened this (osha: inspections, violations and penalties by
 * establishment) named two possible sources: OSHA's own establishment-search
 * HTML page (osha.gov/pls|ords/imis/establishment.search) and DOL's bulk CSV
 * catalog (enforcedata.dol.gov). Neither is what this uses.
 *
 * MEASURED 2026-10-09/10:
 *  - osha.gov's establishment-search HTML sits behind an AWS WAF "Human
 *    Verification" challenge on every GET — HTTP 405/403 with
 *    `x-amzn-waf-action: captcha`, from a plain laptop curl with a full
 *    browser User-Agent, no cookies involved. This is a JS/CAPTCHA wall, not
 *    a UA check — no server-side fetch (a Worker included) can pass it. Live
 *    HTML scraping of that page is not viable.
 *  - enforcedata.dol.gov 301-redirects to data.dol.gov, the SAME React SPA
 *    host the `dol-whd` pack already reverse-engineered. Its real API —
 *    apiprod.dol.gov/v4 — publishes OSHA's inspection and violation TABLES as
 *    a live, per-request, filterable JSON API (not a bulk-download-only
 *    catalog): dataset 10334 "Inspection" (api_url `inspection`) and 10338
 *    "Violation" (api_url `violation`), agency OSHA, frequency "Daily". A
 *    live violation row's `load_dt` during this build was literally the day
 *    before — this is current data, not an archive.
 *  - That means this slice needs NO stored copy, NO KV/D1 baking, and NO
 *    database at all: it is a per-request proxy of a live DOL API, exactly
 *    the `dol-whd` pattern, reusing the SAME platform key
 *    (`platformKeyEnv: 'PLATFORM_DOL_KEY'`, set on the gateway manifest for
 *    this pack).
 *  - Repeats two things `dol-whd` already found the hard way: the row
 *    endpoint (`/v4/get/...`) REJECTS the key as an `X-API-KEY` HEADER (401)
 *    and requires it as a QUERY PARAMETER; a zero-match query answers
 *    HTTP 204 with an EMPTY BODY, not `{"data":[]}`.
 *  - ONE NEW finding, not documented anywhere DOL publishes: `like` matching
 *    on `estab_name` is CASE-SENSITIVE and the column is stored UPPER-CASE.
 *    `%walmart%` answers 204 (no match); `%WALMART%` answers 200 with real
 *    rows for the identical establishment. Every establishment/name argument
 *    here is upper-cased before building the filter — silently lower-casing
 *    it would read as a true no-match on every search.
 *  - The ~20-call/10-minute 429 throttle `dol-whd` documented is real and
 *    shared by this dataset (hit it live while building this). `dolGet`
 *    backs off twice on 429, then refuses with `reason: 'upstream_rate_limited'`
 *    rather than throwing or silently returning `found:false` — matching
 *    `dol-whd`'s `whdFetch`.
 *  - `data_as_of` on every enforcement response is the call's own timestamp:
 *    there is no cache layer to report a load date for — the request IS the
 *    read. "Refresh path": none needed; DOL refreshes the upstream table
 *    daily and every call reads it live.
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

// --- OSHA enforcement (inspections/violations) — live DOL v4 proxy ---------
const DOL_UA = 'pipeworx-osha/0.1 (+https://pipeworx.io)';
const DOL_GET = (dataset: string) => `https://apiprod.dol.gov/v4/get/osha/${dataset}/json`;

type DolOp = 'eq' | 'neq' | 'gt' | 'lt' | 'in' | 'not_in' | 'like';
interface DolCond {
  field: string;
  operator: DolOp;
  value: string | number | Array<string | number>;
}

/**
 * A refusal an agent can act on, rather than a bare throw — same shape as
 * `dol-whd`'s `WhdRefusal`. An expected condition (no key, throttled,
 * upstream 500) returns this payload; a genuine bug still throws.
 */
class OshaEnforcementRefusal extends Error {
  constructor(readonly payload: Record<string, unknown>) {
    super(String(payload.error ?? payload.reason ?? 'refused'));
    this.name = 'OshaEnforcementRefusal';
  }
}

function dolUrl(
  dataset: string,
  conds: DolCond[],
  apiKey: string,
  extra: Record<string, string>,
): string {
  const u = new URL(DOL_GET(dataset));
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  if (conds.length) u.searchParams.set('filter_object', JSON.stringify({ and: conds }));
  // The row endpoint REJECTS the key as a header (401) — query param only.
  u.searchParams.set('X-API-KEY', apiKey);
  return u.toString();
}

async function dolGet<T>(
  dataset: string,
  conds: DolCond[],
  apiKey: string,
  extra: Record<string, string> = {},
): Promise<T[]> {
  const url = dolUrl(dataset, conds, apiKey, extra);

  for (let attempt = 0; ; attempt++) {
    const res = await fetchWithTimeout(
      url,
      { headers: { 'User-Agent': DOL_UA } },
      'DOL Open Data Portal (OSHA)',
    );

    // A zero-match query answers 204 with an EMPTY body, not {"data":[]}.
    if (res.status === 204) return [];

    if (res.status === 429) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt * 2 + 1)));
        continue;
      }
      throw new OshaEnforcementRefusal({
        found: false,
        reason: 'upstream_rate_limited',
        error:
          'The DOL Open Data Portal is throttling requests (HTTP 429) and sends no Retry-After. This is a rate limit, not an empty result.',
        hint: 'Retry in a few minutes — the throttle is per source IP and clears on its own.',
      });
    }

    if (res.status === 401 || res.status === 403) {
      throw new OshaEnforcementRefusal({
        found: false,
        reason: 'auth_required',
        error: `The DOL Open Data Portal rejected the credentials (HTTP ${res.status}).`,
        hint: 'The row endpoint takes the key as an X-API-KEY QUERY PARAMETER, not a header.',
      });
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new OshaEnforcementRefusal({
        found: false,
        reason: 'upstream_error',
        error: `The DOL Open Data Portal returned HTTP ${res.status} for OSHA ${dataset}.`,
        upstream_message: detail.slice(0, 300) || null,
      });
    }

    const text = await res.text();
    if (!text.trim()) return [];
    let body: { data?: T[] };
    try {
      body = JSON.parse(text) as { data?: T[] };
    } catch {
      throw new OshaEnforcementRefusal({
        found: false,
        reason: 'upstream_unparseable',
        error: 'The DOL Open Data Portal returned a body that is not JSON.',
        upstream_message: text.slice(0, 200),
      });
    }
    return body.data ?? [];
  }
}

function requireDolKey(args: Record<string, unknown>): string {
  const key = typeof args._apiKey === 'string' ? args._apiKey.trim() : '';
  if (key) return key;
  throw new OshaEnforcementRefusal({
    found: false,
    reason: 'auth_required',
    error:
      'This tool requires an API key for the US Department of Labor Open Data Portal. Register free at https://dataportal.dol.gov and pass it as _apiKey.',
  });
}

// ---- decode tables, taken from the DOL dataset_metadatum column descriptions
const INSP_TYPE: Record<string, string> = {
  A: 'Accident', B: 'Complaint', C: 'Referral', D: 'Monitoring', E: 'Variance',
  F: 'Follow-up', G: 'Unprogrammed Related', H: 'Planned', I: 'Programmed Related',
  J: 'Unprogrammed Other', K: 'Programmed Other', L: 'Other', M: 'Fatality/Catastrophe',
  N: 'Unprogrammed Emphasis',
};
const INSP_SCOPE: Record<string, string> = {
  A: 'Complete', B: 'Partial', C: 'Records', D: 'No Inspection',
};
const OWNER_TYPE: Record<string, string> = {
  A: 'Private', B: 'Local Government', C: 'State Government', D: 'Federal',
};
const SAFETY_HLTH: Record<string, string> = { S: 'Safety', H: 'Health' };
// S/W/R/O are documented OSHA citation classes; U/C are seen in the live data
// but undocumented by DOL — passed through raw if not in this table.
const VIOL_TYPE: Record<string, string> = {
  S: 'Serious', W: 'Willful', R: 'Repeat', O: 'Other-than-Serious',
};

function decode(table: Record<string, string>, code: unknown): string | null {
  if (typeof code !== 'string' || !code) return null;
  return table[code] ?? code;
}

function isoDate(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  return v.slice(0, 10); // "2026-02-13T00:00:00" -> "2026-02-13"
}

function nowIso(): string {
  return new Date().toISOString();
}

interface OshaInspectionRow {
  activity_nr?: number;
  estab_name?: string;
  site_address?: string;
  site_city?: string;
  site_state?: string;
  site_zip?: string;
  owner_type?: string;
  safety_hlth?: string;
  naics_code?: string;
  insp_type?: string;
  insp_scope?: string;
  nr_in_estab?: string;
  open_date?: string;
  close_case_date?: string;
  [key: string]: unknown;
}

interface OshaViolationRow {
  activity_nr?: number;
  citation_id?: string;
  standard?: string;
  viol_type?: string;
  issuance_date?: string;
  abate_date?: string;
  abate_complete?: string;
  current_penalty?: number;
  initial_penalty?: number;
  contest_date?: string;
  final_order_date?: string;
  nr_instances?: number;
  nr_exposed?: number;
  gravity?: string;
  [key: string]: unknown;
}

function summarizeInspection(r: OshaInspectionRow) {
  return {
    activity_nr: r.activity_nr ?? null,
    establishment: r.estab_name ?? null,
    address: r.site_address ?? null,
    city: r.site_city ?? null,
    state: r.site_state ?? null,
    zip: r.site_zip ?? null,
    naics_code: r.naics_code && r.naics_code !== '000000' ? r.naics_code : null,
    owner_type: decode(OWNER_TYPE, r.owner_type),
    inspection_focus: decode(SAFETY_HLTH, r.safety_hlth),
    inspection_type: decode(INSP_TYPE, r.insp_type),
    inspection_scope: decode(INSP_SCOPE, r.insp_scope),
    open_date: isoDate(r.open_date),
    close_case_date: isoDate(r.close_case_date),
    status: r.close_case_date ? 'closed' : 'open',
    employees_in_establishment: r.nr_in_estab ? Number(r.nr_in_estab) || r.nr_in_estab : null,
  };
}

function summarizeViolation(r: OshaViolationRow) {
  return {
    activity_nr: r.activity_nr ?? null,
    citation_id: r.citation_id ?? null,
    standard_cited: r.standard ?? null,
    violation_type: decode(VIOL_TYPE, r.viol_type),
    issuance_date: isoDate(r.issuance_date),
    abatement_due_date: isoDate(r.abate_date),
    abatement_completed: r.abate_complete === 'X',
    initial_penalty: typeof r.initial_penalty === 'number' ? r.initial_penalty : null,
    current_penalty: typeof r.current_penalty === 'number' ? r.current_penalty : null,
    contested: !!r.contest_date,
    contest_date: isoDate(r.contest_date),
    final_order_date: isoDate(r.final_order_date),
    instances: r.nr_instances ?? null,
    employees_exposed: r.nr_exposed ?? null,
    gravity: r.gravity ?? null,
  };
}

const STATE_RE = /^[A-Za-z]{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function oshaInspections(args: Record<string, unknown>): Promise<unknown> {
  try {
    const apiKey = requireDolKey(args);
    const establishment = typeof args.establishment === 'string' ? args.establishment.trim() : '';
    const stateRaw = typeof args.state === 'string' ? args.state.trim() : '';
    const since = typeof args.since === 'string' ? args.since.trim() : '';
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 25);

    if (!establishment && !stateRaw) {
      return { error: 'Provide at least an establishment name or a state (2-letter postal code).' };
    }
    if (stateRaw && !STATE_RE.test(stateRaw)) {
      return { error: `"${stateRaw}" is not a 2-letter state postal code.` };
    }
    if (since && !DATE_RE.test(since)) {
      return { error: `"${since}" is not a date — use YYYY-MM-DD.` };
    }
    const state = stateRaw.toUpperCase();

    const conds: DolCond[] = [];
    if (establishment) conds.push({ field: 'estab_name', operator: 'like', value: `%${establishment.toUpperCase()}%` });
    if (state) conds.push({ field: 'site_state', operator: 'eq', value: state });
    if (since) conds.push({ field: 'open_date', operator: 'gt', value: since });

    const rows = await dolGet<OshaInspectionRow>('inspection', conds, apiKey, {
      limit: String(limit),
      sort: 'desc',
      sort_by: 'open_date',
    });

    if (rows.length === 0) {
      return {
        found: false,
        establishment: establishment || null,
        state: state || null,
        since: since || null,
        data_as_of: nowIso(),
        hint: 'No OSHA inspection matched. Establishment matching is an UPPER-CASE substring against OSHA\'s own name on file — try a shorter fragment (e.g. "Moran" instead of "Moran Shipping Agencies"), drop the state filter, or check spelling.',
        source: 'DOL Open Data Portal — OSHA Inspection (dataset 10334)',
      };
    }

    return {
      found: true,
      establishment: establishment || null,
      state: state || null,
      since: since || null,
      count: rows.length,
      inspections: rows.map(summarizeInspection),
      data_as_of: nowIso(),
      source: 'DOL Open Data Portal — OSHA Inspection (dataset 10334), refreshed daily; live per-request, no stored copy',
    };
  } catch (e) {
    if (e instanceof OshaEnforcementRefusal) return e.payload;
    throw e;
  }
}

async function oshaInspection(args: Record<string, unknown>): Promise<unknown> {
  try {
    const apiKey = requireDolKey(args);
    const activityNr = Number(args.activity_nr);
    if (!Number.isFinite(activityNr) || activityNr <= 0) {
      return { error: 'Provide activity_nr — the numeric OSHA inspection activity number (e.g. from osha_inspections or osha_establishment_summary).' };
    }

    const [inspRows, violRows] = await Promise.all([
      dolGet<OshaInspectionRow>('inspection', [{ field: 'activity_nr', operator: 'eq', value: activityNr }], apiKey, { limit: '1' }),
      dolGet<OshaViolationRow>('violation', [{ field: 'activity_nr', operator: 'eq', value: activityNr }], apiKey, { limit: '100' }),
    ]);

    if (inspRows.length === 0) {
      return {
        found: false,
        activity_nr: activityNr,
        data_as_of: nowIso(),
        hint: 'No OSHA inspection with this activity number. Activity numbers come from osha_inspections or osha_establishment_summary, not from a free-text search here.',
        source: 'DOL Open Data Portal — OSHA Inspection/Violation (datasets 10334/10338)',
      };
    }

    const violations = violRows.map(summarizeViolation);
    const totalInitial = violations.reduce((s, v) => s + (typeof v.initial_penalty === 'number' ? v.initial_penalty : 0), 0);
    const totalCurrent = violations.reduce((s, v) => s + (typeof v.current_penalty === 'number' ? v.current_penalty : 0), 0);

    return {
      found: true,
      inspection: summarizeInspection(inspRows[0]),
      violation_count: violations.length,
      total_initial_penalty: violations.length ? totalInitial : 0,
      total_current_penalty: violations.length ? totalCurrent : 0,
      violations,
      data_as_of: nowIso(),
      source: 'DOL Open Data Portal — OSHA Inspection/Violation (datasets 10334/10338), refreshed daily; live per-request, no stored copy',
    };
  } catch (e) {
    if (e instanceof OshaEnforcementRefusal) return e.payload;
    throw e;
  }
}

async function oshaEstablishmentSummary(args: Record<string, unknown>): Promise<unknown> {
  try {
    const apiKey = requireDolKey(args);
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    const stateRaw = typeof args.state === 'string' ? args.state.trim() : '';
    if (!name) return { error: 'Provide name — the establishment name to search for.' };
    if (stateRaw && !STATE_RE.test(stateRaw)) {
      return { error: `"${stateRaw}" is not a 2-letter state postal code.` };
    }
    const state = stateRaw.toUpperCase();

    const conds: DolCond[] = [{ field: 'estab_name', operator: 'like', value: `%${name.toUpperCase()}%` }];
    if (state) conds.push({ field: 'site_state', operator: 'eq', value: state });

    const inspRows = await dolGet<OshaInspectionRow>('inspection', conds, apiKey, {
      limit: '50',
      sort: 'desc',
      sort_by: 'open_date',
    });

    if (inspRows.length === 0) {
      return {
        found: false,
        name,
        state: state || null,
        data_as_of: nowIso(),
        hint: 'No OSHA inspection matched. Establishment matching is an UPPER-CASE substring against OSHA\'s own name on file — try a shorter fragment of the name.',
        source: 'DOL Open Data Portal — OSHA Inspection (dataset 10334)',
      };
    }

    const activityNrs = [...new Set(
      inspRows.map((r) => r.activity_nr).filter((n): n is number => typeof n === 'number'),
    )];
    const violRows = activityNrs.length
      ? await dolGet<OshaViolationRow>(
          'violation',
          [{ field: 'activity_nr', operator: 'in', value: activityNrs }],
          apiKey,
          { limit: '1000' },
        )
      : [];

    const totalCurrent = violRows.reduce((s, v) => s + (typeof v.current_penalty === 'number' ? v.current_penalty : 0), 0);
    const totalInitial = violRows.reduce((s, v) => s + (typeof v.initial_penalty === 'number' ? v.initial_penalty : 0), 0);
    const sorted = [...inspRows].sort((a, b) => String(b.open_date ?? '').localeCompare(String(a.open_date ?? '')));
    const matchedNames = [...new Set(inspRows.map((r) => r.estab_name).filter((n): n is string => !!n))];

    return {
      found: true,
      name,
      state: state || null,
      inspection_count: inspRows.length,
      inspection_count_note: inspRows.length === 50 ? 'Capped at 50 most recent inspections — narrow with a state to see the rest.' : null,
      violation_count: violRows.length,
      total_initial_penalty: totalInitial,
      total_current_penalty: totalCurrent,
      last_inspection_date: isoDate(sorted[0]?.open_date),
      establishments_matched: matchedNames.slice(0, 10),
      data_as_of: nowIso(),
      source: 'DOL Open Data Portal — OSHA Inspection/Violation (datasets 10334/10338), refreshed daily; live per-request, no stored copy',
    };
  } catch (e) {
    if (e instanceof OshaEnforcementRefusal) return e.payload;
    throw e;
  }
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
  {
    name: 'osha_inspections',
    description:
      'OSHA inspections for a named establishment and/or state — the enforcement record OSHA actually took, not the standards. Answers "has OSHA inspected X", "list OSHA inspections for X", "OSHA inspections in state X since date Y". Returns each inspection\'s address, NAICS code, whether it was a safety or health inspection, the inspection type (Accident / Complaint / Programmed / Referral / Fatality-Catastrophe / etc.), scope, open/close dates, and open-vs-closed status. Establishment matching is a substring match against OSHA\'s name on file (case-insensitive on input, matched upper-case) — a shorter fragment of the name finds more. Requires establishment or state (or both); `since` narrows to inspections opened after that date. Example: osha_inspections({ establishment: "Walmart", state: "TX" }); osha_inspections({ establishment: "Moran Towing", since: "2020-01-01" }). Live US Dept. of Labor data, refreshed daily. Use osha_inspection with the returned activity_nr for violations and penalties.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        establishment: {
          type: 'string',
          description: 'Establishment / company name, or a fragment of it, e.g. "Walmart", "Moran Towing". Matched as an upper-cased substring.',
        },
        state: { type: 'string', description: '2-letter US state postal code of the inspected site, e.g. "TX", "NY".' },
        since: { type: 'string', description: 'Only inspections opened after this date, YYYY-MM-DD, e.g. "2020-01-01".' },
        limit: { type: 'number', description: 'Max inspections to return, 1–25 (default 10).' },
      },
    },
  },
  {
    name: 'osha_inspection',
    description:
      'One OSHA inspection by its activity number (from osha_inspections or osha_establishment_summary): the inspection record plus every violation cited — standard cited, violation type (Serious/Willful/Repeat/Other-than-Serious), issuance and abatement dates, instances, employees exposed, and BOTH the initial and current (post-contest/settlement) penalty amounts, plus the summed totals. Answers "what violations came out of inspection X", "what did OSHA fine them for this inspection", "penalty amounts for activity number X". Example: osha_inspection({ activity_nr: 348458035 }). Live US Dept. of Labor data.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        activity_nr: {
          type: 'number',
          description: 'The numeric OSHA inspection activity number, e.g. 348458035. Get it from osha_inspections or osha_establishment_summary.',
        },
      },
      required: ['activity_nr'],
    },
  },
  {
    name: 'osha_establishment_summary',
    description:
      'Rolled-up OSHA enforcement history for an establishment: how many inspections, how many violations, total initial and current penalty amounts across all of them, the most recent inspection date, and the distinct establishment names OSHA has on file matching the search (chains and renamed sites often appear under several). Answers "has OSHA fined X", "total OSHA penalties for X", "how many times has OSHA inspected X", "OSHA enforcement summary for X". Narrower and faster to read than paging through osha_inspections yourself. Example: osha_establishment_summary({ name: "Walmart", state: "AR" }). Live US Dept. of Labor data, refreshed daily; capped at the 50 most recent inspections per establishment — narrow with state for a complete count on a national chain.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Establishment / company name, or a fragment of it. Matched as an upper-cased substring.' },
        state: { type: 'string', description: '2-letter US state postal code to narrow to one state, e.g. "AR".' },
      },
      required: ['name'],
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
      case 'osha_inspections':
        return oshaInspections(args);
      case 'osha_inspection':
        return oshaInspection(args);
      case 'osha_establishment_summary':
        return oshaEstablishmentSummary(args);
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
