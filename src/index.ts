#!/usr/bin/env node
/**
 * mathter-mcp — a Model Context Protocol server for Mathter (https://mathter.ca).
 *
 * It is a thin HTTP client and nothing else. Two tools:
 *   - `list_skills`            GET  {baseUrl}/api/skills   (public, no key sent)
 *   - `generate_worksheet_pack` POST {baseUrl}/api/generate (Authorization: Bearer mk_live_…)
 *
 * Design rules this file is held to, because it runs on a teacher's machine inside a chat
 * transcript they may paste somewhere else:
 *
 *  1. The API key appears in exactly one place: the Authorization header of the generate call.
 *     Everything leaving this process passes one of exactly TWO redaction boundaries —
 *     `redactResult` for every tool result and `say` for every stderr line — rather than a
 *     `redact()` call per message, so a branch added later cannot forget. Server-supplied text
 *     is never trusted to be key-free; see `redact`'s comment.
 *  2. Nothing is ever written to stdout. stdout is the MCP transport; a stray console.log there
 *     corrupts the protocol stream. Diagnostics go to stderr.
 *  3. The generate tool returns a FILE PATH, not base64. The person asking for a worksheet pack
 *     wants something they can open and print.
 *  4. The input schema below is read by a model to decide what to send, so it is documentation as
 *     much as validation. Every cap in it mirrors a line of the real route — see the citations.
 *     The one list it deliberately does NOT carry is the ~70 skill keys: those change, and a
 *     stale copy here would turn into unexplained `400 Invalid configuration.` responses. The
 *     model is pointed at `list_skills` instead.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Kept in step with package.json by hand; it is only ever reported, never compared. */
const VERSION = "0.1.0";

const DEFAULT_BASE_URL = "https://mathter.ca";

/**
 * A pack render drives headless Chrome on the server, so it is slow by nature — minutes, not
 * seconds, for a large pack. Long enough not to abandon a pack that is genuinely coming, short
 * enough that a dead connection surfaces as an error instead of a hung chat.
 */
const REQUEST_TIMEOUT_MS = 180_000;

const REDACTED = "[redacted API key]";

export interface MathterConfig {
  apiKey: string;
  /** No trailing slash. */
  baseUrl: string;
  outDir: string;
}

export const MISSING_KEY_MESSAGE =
  "MATHTER_API_KEY is not set. mathter-mcp cannot do anything without it, so it is stopping now " +
  "rather than failing later with a confusing 401.\n" +
  "Create a key at https://mathter.ca/account (API access), then put it in this server's env, e.g.\n" +
  '  "mathter": { "command": "npx", "args": ["-y", "mathter-mcp"], ' +
  '"env": { "MATHTER_API_KEY": "<paste your key here>" } }\n' +
  "Restart your MCP client after saving the config.";

/**
 * Strip anything key-shaped out of a string before it leaves the process.
 *
 * Both halves matter. The exact-key pass covers our own interpolations; the pattern pass covers
 * text we did not write — an error body from the server, a proxy's echo of the request headers, a
 * captive-portal page. We do include the server's own error message in tool output because it is
 * genuinely useful, and that is exactly the untrusted path, so it is filtered here.
 */
export function redact(text: string, apiKey?: string): string {
  let out = text;
  if (apiKey && apiKey.length >= 8) out = out.split(apiKey).join(REDACTED);
  return out.replace(/\bmk_[a-z]+_[A-Za-z0-9_-]+/g, REDACTED);
}

/**
 * Where packs land when MATHTER_OUT_DIR is unset: the OS downloads folder if there is one,
 * otherwise the temp dir. Never the process working directory — for an MCP server launched by a
 * desktop app that is some unrelated place the person will never find.
 */
export function defaultOutDir(env: NodeJS.ProcessEnv = process.env): string {
  const candidates: string[] = [];
  // Honoured on Linux desktops that have localised or relocated the folder.
  if (env.XDG_DOWNLOAD_DIR) candidates.push(env.XDG_DOWNLOAD_DIR);
  const home = env.HOME || env.USERPROFILE || homedir();
  if (home) candidates.push(join(home, "Downloads"));
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return tmpdir();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MathterConfig {
  const apiKey = (env.MATHTER_API_KEY ?? "").trim();
  if (!apiKey) throw new Error(MISSING_KEY_MESSAGE);

  const raw = (env.MATHTER_BASE_URL ?? DEFAULT_BASE_URL).trim();
  let baseUrl: string;
  try {
    const parsed = new URL(raw);
    baseUrl = parsed.origin + parsed.pathname.replace(/\/+$/, "");
  } catch {
    throw new Error(
      `MATHTER_BASE_URL is not a valid URL: "${raw}". Leave it unset to use ${DEFAULT_BASE_URL}.`,
    );
  }

  const outDir = (env.MATHTER_OUT_DIR ?? "").trim() || defaultOutDir(env);
  return { apiKey, baseUrl, outDir };
}

// ---------------------------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------------------------

// Every cap below mirrors what POST https://mathter.ca/api/generate actually enforces, read
// off the endpoint's own implementation and its API documentation on 2026-10-04. Re-check them
// against the live endpoint before changing any number here.
const GENERATE_SCHEMA = {
  type: "object",
  properties: {
    skill: {
      type: "string",
      description:
        "Which math skill the pack drills, e.g. \"multiplication\". Call list_skills first and " +
        "use one of the keys it returns: the set changes, and the skill must be one the chosen " +
        "grade is taught. An unknown or out-of-grade skill is rejected with 400.",
    },
    grade: {
      type: "integer",
      minimum: 0,
      maximum: 12,
      description:
        "Grade level, 0 (kindergarten) to 12. Must be a grade the chosen skill teaches — " +
        "list_skills returns the grades for each skill.",
    },
    theme: {
      type: "string",
      enum: ["teal", "tangerine", "ocean", "plum", "berry", "forest", "slate", "crimson", "grape", "cocoa"],
      default: "teal",
      description: "Colour palette for the pack. Available on every plan. Defaults to teal.",
    },
    style: {
      type: "string",
      enum: ["modern", "classic", "notebook", "studio", "ledger", "blueprint"],
      description:
        "Typography/layout preset, default \"modern\". Plan-gated and rejected outright if the " +
        "account cannot use it: free accounts have \"modern\" only, Standard adds \"classic\" " +
        "and \"notebook\", Premium has all six. Omit it unless the person asked for a look.",
    },
    difficulty: {
      type: "string",
      enum: ["easy", "medium", "hard"],
      description: "Difficulty band, default \"medium\".",
    },
    title: {
      type: "string",
      maxLength: 80,
      description: "Title printed on the pack, default \"Math Lesson\". Truncated at 80 characters.",
    },
    worksheetCount: {
      type: "integer",
      minimum: 1,
      description:
        "How many worksheets in the pack. Clamped to the account's plan — free 2, Standard 10, " +
        "Premium 25 — so asking for more is harmless but gets fewer. Omitted, it is 10 or the " +
        "plan's cap, whichever is smaller: a free account's default pack is 2 sheets.",
    },
    problemsPerPage: {
      type: "integer",
      minimum: 1,
      description:
        "Questions per page, default 12. Clamped down to whatever actually fits one page for " +
        "this skill, grade and layout, so a large number simply gives the densest legal page.",
    },
    includeAnswerKeys: {
      type: "boolean",
      description: "Print answer keys. Default true on every plan; send false to omit them.",
    },
    includeCover: {
      type: "boolean",
      description: "Print a cover page. Default true, but silently off for free accounts (Standard and up).",
    },
    includeLesson: {
      type: "boolean",
      description: "Print the \"how to\" lesson page. Default true, silently off for free accounts (Standard and up).",
    },
    workedSolutions: {
      type: "boolean",
      description:
        "Step-by-step worked solutions in the answer key. Only has an effect for skills that " +
        "have steps authored; silently ignored elsewhere.",
    },
    diagrams: {
      type: "boolean",
      description: "Geometry skills only: labelled figures instead of text prompts. Ignored for other skills.",
    },
    graphBlank: {
      type: "boolean",
      description: "Use a blank, unlabelled coordinate grid. Only meaningful where the skill prints a graph.",
    },
    unitSystem: {
      type: "string",
      enum: ["metric", "imperial"],
      description: "Units for measurement questions, default metric. Mainly affects unit-conversion skills.",
    },
    focus: {
      type: "integer",
      minimum: 1,
      maximum: 12,
      description:
        "Single-number drill, e.g. 7 for the seven times table. Only applies to the four fact " +
        "skills: addition, subtraction, multiplication, division.",
    },
    focusOrder: {
      type: "string",
      enum: ["sequential", "shuffled"],
      description: "Order of a focus drill, default sequential. Only applies when focus is set.",
    },
    chart: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["filled", "blank"] },
      },
      required: ["mode"],
      additionalProperties: false,
      description:
        "Multiplication only: print a times-table chart instead of worksheets. \"filled\" is a " +
        "reference chart, \"blank\" is one to fill in.",
    },
    timed: {
      type: "boolean",
      description: "Mad-minute timed drill. Only applies to addition, subtraction, multiplication and division.",
    },
    shopName: {
      type: "string",
      maxLength: 60,
      description:
        "Branding name printed on the pack. Premium only — on any other account it is silently " +
        "replaced with \"Mathter.ca\" and the pack still generates. Members of a school " +
        "organisation always get the organisation's own branding instead.",
    },
    seed: {
      type: "integer",
      description: "Fixes the random number generator, so the same seed reproduces the same pack. Default random.",
    },
  },
  required: ["skill", "grade"],
  additionalProperties: false,
} as const;

export const TOOLS: Tool[] = [
  {
    name: "generate_worksheet_pack",
    title: "Generate a Mathter worksheet pack",
    description:
      "Generate a printable math worksheet pack as a PDF and save it to this computer, then " +
      "return the file path. The pack is billed to the Mathter account that owns MATHTER_API_KEY, " +
      "under that account's normal monthly allowance — the same as making it on mathter.ca. " +
      "Call list_skills first to choose a valid skill for the grade. Logo and branding come from " +
      "the account itself and cannot be set here.",
    // `as const` above keeps the literal types (so a typo in an enum value is a compile error
    // here rather than a silent runtime oddity); the SDK's Tool type wants a mutable JSON Schema
    // object, hence the one cast.
    inputSchema: GENERATE_SCHEMA as unknown as Tool["inputSchema"],
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "list_skills",
    title: "List Mathter skills",
    description:
      "List every math skill Mathter can generate right now and the grades each one covers. The " +
      "live list, straight from mathter.ca — use it to pick the `skill` and `grade` for " +
      "generate_worksheet_pack rather than guessing a key.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

// ---------------------------------------------------------------------------------------------
// HTTP error mapping
// ---------------------------------------------------------------------------------------------

export interface ErrorContext {
  /** "key" = the authenticated generate endpoint; "public" = /api/skills, which sends no key. */
  caller: "key" | "public";
  /** The URL that was actually requested — quoted back when the base URL looks wrong. */
  url: string;
}

/**
 * Turn a non-2xx response into something the person reading the chat can act on. The status alone
 * ("402") tells them nothing; "this account is out of worksheet credits for the month" tells them
 * what to do next. The statuses and bodies below are the ones Mathter's API actually returns.
 */
export function describeHttpError(
  status: number,
  body: { error?: unknown; code?: unknown } | null,
  retryAfter: string | null,
  ctx: ErrorContext,
): string {
  const seconds = Number(retryAfter);
  const wait = Number.isFinite(seconds) && seconds > 0 ? `${Math.ceil(seconds)} seconds` : null;
  // Cloudflare's own 5xx range: the edge answered, the origin did not. Different advice from a
  // 500, which means Mathter ran and failed.
  if (status >= 520 && status <= 527) {
    return (
      `Mathter's server could not be reached (HTTP ${status} from its edge network). That is an ` +
      "outage or a network problem between the edge and the site, not something wrong with this " +
      "request. Try again in a few minutes."
    );
  }

  switch (status) {
    case 400:
      return (
        "Mathter rejected that configuration. The usual cause is a skill key that does not exist, " +
        "or a skill that is not taught at the grade asked for. Call list_skills and pick a skill " +
        "whose grade list contains that grade, then try again."
      );
    case 401:
      return (
        "Mathter did not accept the API key. MATHTER_API_KEY is wrong, mistyped, or the key has " +
        "been revoked. Create a fresh key at https://mathter.ca/account, put it in this server's " +
        "env, and restart the MCP client — nothing else will work until then."
      );
    case 402:
      if (body?.code === "pro_style") {
        return (
          "That style is not available on this account's plan. Free accounts have \"modern\" only; " +
          "Standard adds \"classic\" and \"notebook\"; Premium has all six. Either leave the style " +
          "out and try again, or upgrade at https://mathter.ca/pricing."
        );
      }
      return (
        "This account is out of worksheet credits for the month. The allowance resets at the start " +
        "of the next billing period; to generate more now, upgrade at https://mathter.ca/pricing. " +
        "Nothing was charged for this attempt."
      );
    case 403:
      return (
        "This account is not allowed to generate packs. Two kinds of account hit this: an admin/support " +
        "account, which has no worksheet access at all, and a member of a school organisation " +
        "whose licence no longer covers them. Use a key from an ordinary teacher account, or ask " +
        "the school's Mathter admin to restore access."
      );
    case 429:
      // list_skills sends no key at all and is limited per IP, so blaming "this key" there is
      // not just imprecise — it invites a teacher to revoke a perfectly good key over it.
      return ctx.caller === "key"
        ? "Mathter is rate-limiting this API key — too fast, too many requests. " +
          (wait ? `Wait ${wait} and try again.` : "Wait a minute or two and try again.") +
          " Generating one pack at a time avoids this. Your key is fine; nothing needs revoking."
        : "Mathter is rate-limiting the public skill list, which is limited per computer (by IP) " +
          "and never sees your API key. " +
          (wait ? `Wait ${wait} and try again.` : "Wait a minute and try again.") +
          " Your key is fine; nothing needs revoking.";
    case 503:
      return (
        "Mathter's worksheet renderer is busy and could not take this pack. " +
        (wait ? `Retry in ${wait}.` : "Retry in about 30 seconds.") +
        " Nothing was charged and nothing is broken — it is queue backpressure."
      );
    case 404:
      return (
        `Nothing is listening at ${ctx.url}. Mathter's own address has that endpoint, so the ` +
        "usual cause is a wrong MATHTER_BASE_URL — unset it to use https://mathter.ca, or correct " +
        "it if you meant to point at a different instance."
      );
    case 502:
    case 504:
      return (
        `Mathter's server did not answer its front door (HTTP ${status}). That is an outage or a ` +
        "network problem, not something wrong with this request. Try again in a few minutes."
      );
    case 500:
      return (
        "Mathter hit a server error. This is not your request's fault — the same call will " +
        "probably work in a moment, so try again, and report it via https://mathter.ca/contact if " +
        "it keeps happening."
      );
    default:
      return (
        `Mathter returned an unexpected HTTP ${status}. Try again in a moment; if it persists, ` +
        "report it via https://mathter.ca/contact."
      );
  }
}

async function readErrorBody(res: Response): Promise<{ parsed: { error?: unknown; code?: unknown } | null; text: string }> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    return { parsed: null, text: "" };
  }
  try {
    const parsed = JSON.parse(text) as { error?: unknown; code?: unknown };
    return { parsed, text: typeof parsed.error === "string" ? parsed.error : text };
  } catch {
    return { parsed: null, text };
  }
}

/**
 * The server's own words, appended for context — truncated. NOT redacted here: everything this
 * function feeds goes out through `redactResult`, and scattering the filter is what let two
 * paths quietly skip it the first time round.
 */
function serverSaid(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  return `\n\nMathter said: ${cleaned.slice(0, 200)}`;
}

class ToolError extends Error {}

// ---------------------------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------------------------

type Args = Record<string, unknown>;

function asInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  // Models routinely send numbers as strings; accept that rather than bouncing a usable request.
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Math.trunc(Number(value));
  }
  return undefined;
}

function asBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Build the POST body from the model's arguments — an allowlist, not a pass-through. Anything the
 * route does not read is dropped here rather than sent and ignored, and anything the caller left
 * out is omitted entirely so the server's own default applies.
 */
export function buildGenerateBody(args: Args): Record<string, unknown> {
  const skill = asString(args.skill);
  if (!skill) throw new ToolError("The `skill` option is required. Call list_skills to see the valid skill keys.");
  const grade = asInt(args.grade);
  if (grade === undefined || grade < 0 || grade > 12) {
    throw new ToolError(
      "The `grade` option is required and must be a whole number from 0 (kindergarten) to 12. " +
        "list_skills says which grades each skill covers.",
    );
  }

  const body: Record<string, unknown> = {
    skill,
    grade,
    // The route requires a theme and 400s without one; a missing theme is a palette the caller
    // did not care about, not an error worth bouncing back to them.
    theme: asString(args.theme) ?? "teal",
  };

  const put = (key: string, value: unknown) => {
    if (value !== undefined) body[key] = value;
  };
  put("style", asString(args.style));
  put("difficulty", asString(args.difficulty));
  put("title", asString(args.title));
  put("shopName", asString(args.shopName));
  put("unitSystem", asString(args.unitSystem));
  put("worksheetCount", asInt(args.worksheetCount));
  put("problemsPerPage", asInt(args.problemsPerPage));
  put("seed", asInt(args.seed));
  put("includeAnswerKeys", asBool(args.includeAnswerKeys));
  put("includeCover", asBool(args.includeCover));
  put("includeLesson", asBool(args.includeLesson));
  put("workedSolutions", asBool(args.workedSolutions));
  put("diagrams", asBool(args.diagrams));
  put("graphBlank", asBool(args.graphBlank));
  put("timed", asBool(args.timed));

  const focus = asInt(args.focus);
  if (focus !== undefined && focus >= 1 && focus <= 12) {
    body.focus = focus;
    put("focusOrder", asString(args.focusOrder));
  }

  const chart = args.chart as { mode?: unknown } | undefined;
  const chartMode = chart && typeof chart === "object" ? asString(chart.mode) : undefined;
  if (chartMode === "filled" || chartMode === "blank") body.chart = { mode: chartMode };

  return body;
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

/** `mathter-grade-4-multiplication-2026-10-04-1532.pdf` — sortable, searchable, obviously ours. */
export function packFilename(skill: string, grade: number, now: Date = new Date()): string {
  const slug = skill.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "pack";
  const stamp =
    `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}` +
    `-${two(now.getHours())}${two(now.getMinutes())}`;
  return `mathter-grade-${grade}-${slug}-${stamp}.pdf`;
}

function uniquePath(dir: string, filename: string): string {
  const base = filename.replace(/\.pdf$/, "");
  let candidate = join(dir, filename);
  for (let i = 2; existsSync(candidate) && i < 1000; i++) candidate = join(dir, `${base}-${i}.pdf`);
  return candidate;
}

// ---------------------------------------------------------------------------------------------
// The tools themselves
// ---------------------------------------------------------------------------------------------

async function request(url: string, init: RequestInit, cfg: MathterConfig): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new ToolError(
        `Mathter did not answer within ${Math.round(REQUEST_TIMEOUT_MS / 1000)} seconds. Large packs ` +
          "are slow to render — try again, or ask for fewer worksheets.",
      );
    }
    throw new ToolError(
      `Could not reach Mathter at ${cfg.baseUrl}. Check the internet connection and MATHTER_BASE_URL. ` +
        `(${String((e as Error)?.message ?? e)})`,
    );
  }
}

export async function generateWorksheetPack(args: Args, cfg: MathterConfig): Promise<string> {
  const body = buildGenerateBody(args);
  const res = await request(
    `${cfg.baseUrl}/api/generate`,
    {
      method: "POST",
      headers: {
        // The one and only place the key is used.
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/pdf, application/json",
        "User-Agent": `mathter-mcp/${VERSION}`,
      },
      body: JSON.stringify(body),
    },
    cfg,
  );

  if (!res.ok) {
    const { parsed, text } = await readErrorBody(res);
    throw new ToolError(
      describeHttpError(res.status, parsed, res.headers.get("retry-after"), {
        caller: "key",
        url: `${cfg.baseUrl}/api/generate`,
      }) + serverSaid(text),
    );
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) {
    throw new ToolError("Mathter returned an empty file. Nothing was saved; try again.");
  }
  // A 200 is not proof of a PDF. A proxy, a captive portal or a misrouted MATHTER_BASE_URL can
  // all answer 200 with HTML or JSON, and saving that under a .pdf name gives the teacher a file
  // that silently will not open. Four bytes settle it.
  if (bytes.subarray(0, 4).toString("latin1") !== "%PDF") {
    throw new ToolError(
      `Mathter answered, but not with a PDF — nothing was saved. Check MATHTER_BASE_URL points at ` +
        `Mathter (currently ${cfg.baseUrl}) and that no proxy is intercepting the request.`,
    );
  }

  mkdirSync(cfg.outDir, { recursive: true });
  const path = uniquePath(cfg.outDir, packFilename(String(body.skill), Number(body.grade)));
  writeFileSync(path, bytes);

  const count = typeof body.worksheetCount === "number" ? body.worksheetCount : 10;
  const kb = Math.max(1, Math.round(bytes.length / 1024));
  return (
    `Saved a grade ${body.grade} ${body.skill} pack to ${path} ` +
    `(${count} worksheets requested — the account's plan may cap the actual number — ${kb} KB). ` +
    "Open or print that file."
  );
}

export async function listSkills(cfg: MathterConfig): Promise<string> {
  // No Authorization header: /api/skills is public, so sending the key would widen its exposure
  // for nothing.
  const res = await request(
    `${cfg.baseUrl}/api/skills`,
    { method: "GET", headers: { Accept: "application/json", "User-Agent": `mathter-mcp/${VERSION}` } },
    cfg,
  );

  if (!res.ok) {
    const { parsed, text } = await readErrorBody(res);
    throw new ToolError(
      describeHttpError(res.status, parsed, res.headers.get("retry-after"), {
        caller: "public",
        url: `${cfg.baseUrl}/api/skills`,
      }) + serverSaid(text),
    );
  }

  const data = (await res.json().catch(() => null)) as { skills?: Array<{ key?: string; label?: string; grades?: number[] }> } | null;
  const skills = Array.isArray(data?.skills) ? data.skills : [];
  if (skills.length === 0) {
    throw new ToolError(
      `Mathter returned no skills from ${cfg.baseUrl}/api/skills. That is unexpected — try again shortly.`,
    );
  }

  const lines = skills.map((s) => {
    const grades = Array.isArray(s.grades) ? s.grades.join(", ") : "";
    return `- ${s.key} — ${s.label ?? s.key} — grades ${grades}`;
  });
  return `${skills.length} skills available (grade 0 is kindergarten):\n${lines.join("\n")}`;
}

/**
 * The single outbound filter for tool results. Every text block of every result — success,
 * mapped error, unexpected throw, unknown tool name — passes through here on its way to the
 * client, so a branch added later cannot opt out of redaction by forgetting to call it. The
 * first version of this file spread `redact()` over six call sites and two paths had already
 * missed it; one boundary is the fix, not more diligence.
 */
function redactResult(result: CallToolResult, apiKey: string): CallToolResult {
  return {
    ...result,
    content: result.content.map((block) =>
      block.type === "text" && typeof block.text === "string"
        ? { ...block, text: redact(block.text, apiKey) }
        : block,
    ),
  };
}

export async function handleCallTool(name: string, args: Args, cfg: MathterConfig): Promise<CallToolResult> {
  return redactResult(await runTool(name, args, cfg), cfg.apiKey);
}

async function runTool(name: string, args: Args, cfg: MathterConfig): Promise<CallToolResult> {
  try {
    if (name === "generate_worksheet_pack") {
      return { content: [{ type: "text", text: await generateWorksheetPack(args ?? {}, cfg) }] };
    }
    if (name === "list_skills") {
      return { content: [{ type: "text", text: await listSkills(cfg) }] };
    }
    return {
      isError: true,
      content: [{
        type: "text",
        text: `mathter-mcp has no tool called "${name}". It offers generate_worksheet_pack and list_skills.`,
      }],
    };
  } catch (e) {
    const message = e instanceof ToolError ? e.message : `mathter-mcp failed: ${String((e as Error)?.message ?? e)}`;
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}

// ---------------------------------------------------------------------------------------------
// Server wiring
// ---------------------------------------------------------------------------------------------

export function createMcpServer(cfg: MathterConfig): Server {
  const server = new Server(
    { name: "mathter-mcp", version: VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    handleCallTool(req.params.name, (req.params.arguments ?? {}) as Args, cfg),
  );
  return server;
}

export interface MainIO {
  stderr: (line: string) => void;
  exit: (code: number) => void;
}

const processIO: MainIO = {
  // stderr, never stdout: stdout is the MCP transport.
  stderr: (line) => process.stderr.write(`${line}\n`),
  exit: (code) => process.exit(code),
};

export async function main(env: NodeJS.ProcessEnv = process.env, io: MainIO = processIO): Promise<void> {
  // The second (and last) redaction boundary: nothing reaches stderr except through here.
  const say = (line: string, apiKey?: string) => io.stderr(redact(line, apiKey));
  let cfg: MathterConfig;
  try {
    cfg = loadConfig(env);
  } catch (e) {
    // Fail here, loudly, rather than letting a missing key become a 401 on the first worksheet.
    say(String((e as Error)?.message ?? e));
    io.exit(1);
    return;
  }
  const server = createMcpServer(cfg);
  await server.connect(new StdioServerTransport());
  say(`mathter-mcp ${VERSION} ready — ${cfg.baseUrl}, packs saved to ${cfg.outDir}`, cfg.apiKey);
}

/**
 * Is this file the program being run, as opposed to a module someone imported?
 *
 * The naive comparison — `import.meta.url === pathToFileURL(process.argv[1]).href` — is WRONG
 * for the way this package is actually installed. `npm`/`npx` put a `bin` into
 * `node_modules/.bin` as a SYMLINK; Node resolves symlinks when it computes `import.meta.url`
 * but leaves `process.argv[1]` as the symlink path it was given. The two never match, `main()`
 * never runs, and `npx -y mathter-mcp` exits 0 having printed nothing — on macOS and Linux
 * only, because npm writes a `.cmd` shim with the real path on Windows. Resolve the symlink
 * first. See the child-process test, which runs the built file through a symlink exactly as
 * npm would.
 */
export function isDirectRun(metaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  let resolved = argv1;
  try {
    resolved = realpathSync(argv1);
  } catch {
    // argv[1] deleted, or on a filesystem we cannot stat. Fall back to the raw path rather than
    // taking the process down over a liveness check.
  }
  return metaUrl === pathToFileURL(resolved).href;
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  void main();
}
