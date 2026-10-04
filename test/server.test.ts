// Tests for the mathter-mcp stdio server.
//
// Everything here runs against a LOCAL STUB of the Mathter API started on an ephemeral port --
// never mathter.ca, never a real key. The stub is deliberately hostile in one specific way: every
// error body it returns echoes the Authorization header back to the client. A naive
// implementation that pastes the server's `error` string into its tool output would leak the
// caller's API key into the chat transcript, and the leak tests below would catch it. Remove the
// redaction from src/index.ts and this file goes red.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TOOLS,
  defaultOutDir,
  handleCallTool,
  loadConfig,
  main,
  type MathterConfig,
} from "../src/index";

const TEST_KEY = "mk_live_TESTKEY0000000000000000000000ff";
const PDF_BYTES = Buffer.from("%PDF-1.7\n% mathter-mcp stub pack\n%%EOF\n", "utf8");

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  body: string;
}

interface Stub {
  baseUrl: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

type StubHandler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

const openStubs: Server[] = [];
const tempDirs: string[] = [];

async function startStub(handler: StubHandler): Promise<Stub> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers as Record<string, string | undefined>,
        body,
      });
      handler(req, res, body);
    });
  });
  openStubs.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A stub that always fails with `status`, echoing the bearer key back in its error body. */
function failingStub(status: number, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return async () =>
    startStub((req, res, _body) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(
        JSON.stringify({
          error: `stub failure for ${status}; caller sent ${req.headers.authorization ?? "(nothing)"}`,
          ...extra,
        }),
      );
    });
}

function okPdfStub() {
  return startStub((_req, res) => {
    res.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="multiplication-4-123.pdf"',
      "X-Usage-Used": "3",
      "X-Usage-Quota": "20",
    });
    res.end(PDF_BYTES);
  });
}

function makeOutDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mathter-mcp-test-"));
  tempDirs.push(dir);
  return dir;
}

function cfg(baseUrl: string, outDir = makeOutDir()): MathterConfig {
  return { apiKey: TEST_KEY, baseUrl, outDir };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? "").join("\n");
}

const VALID_ARGS = { skill: "multiplication", grade: 4, theme: "teal", worksheetCount: 5 };

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(openStubs.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("configuration", () => {
  it("fails immediately when MATHTER_API_KEY is missing, naming the variable", () => {
    expect(() => loadConfig({})).toThrow(/MATHTER_API_KEY/);
    expect(() => loadConfig({ MATHTER_API_KEY: "   " })).toThrow(/MATHTER_API_KEY/);
  });

  it("startup aborts with a clear message and exit code 1 rather than a confusing 401 later", async () => {
    const stderr: string[] = [];
    let exitCode: number | undefined;
    await main({}, { stderr: (line) => stderr.push(line), exit: (code) => { exitCode = code; } });
    const out = stderr.join("\n");
    expect(exitCode).toBe(1);
    expect(out).toMatch(/MATHTER_API_KEY/);
    // Actionable: says where a key comes from, not just that one is absent.
    expect(out).toMatch(/mathter\.ca\/account/);
  });

  it("defaults the base URL and trims a trailing slash from an override", () => {
    expect(loadConfig({ MATHTER_API_KEY: TEST_KEY }).baseUrl).toBe("https://mathter.ca");
    expect(loadConfig({ MATHTER_API_KEY: TEST_KEY, MATHTER_BASE_URL: "http://localhost:3000/" }).baseUrl)
      .toBe("http://localhost:3000");
  });

  it("honours MATHTER_OUT_DIR, else the downloads dir, else tmp", () => {
    expect(loadConfig({ MATHTER_API_KEY: TEST_KEY, MATHTER_OUT_DIR: "/tmp/packs" }).outDir).toBe("/tmp/packs");
    expect(defaultOutDir({ XDG_DOWNLOAD_DIR: "/tmp" })).toBe("/tmp");
    // No home, no XDG hint -> tmp, never a crash and never the process cwd.
    expect(defaultOutDir({ HOME: "/nonexistent-home-xyz" })).toBe(tmpdir());
  });
});

describe("tool definitions", () => {
  it("exposes exactly the two documented tools over stdio", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual(["generate_worksheet_pack", "list_skills"]);
  });

  it("requires skill and grade, and points the model at list_skills instead of enumerating skills", () => {
    const gen = TOOLS.find((t) => t.name === "generate_worksheet_pack")!;
    const schema = gen.inputSchema as {
      required?: string[];
      properties: Record<string, { enum?: unknown[]; maximum?: number; minimum?: number; maxLength?: number; description?: string }>;
    };
    expect(schema.required).toEqual(["skill", "grade"]);
    // The ~70 skill keys change; a copy here would rot. The description must route to list_skills.
    expect(schema.properties.skill?.enum).toBeUndefined();
    expect(schema.properties.skill?.description).toMatch(/list_skills/);
    // Caps that mirror the real route.
    expect(schema.properties.grade?.minimum).toBe(0);
    expect(schema.properties.grade?.maximum).toBe(12);
    expect(schema.properties.focus?.minimum).toBe(1);
    expect(schema.properties.focus?.maximum).toBe(12);
    expect(schema.properties.title?.maxLength).toBe(80);
    expect(schema.properties.shopName?.maxLength).toBe(60);
    expect(schema.properties.difficulty?.enum).toEqual(["easy", "medium", "hard"]);
    expect(schema.properties.style?.enum).toEqual([
      "modern", "classic", "notebook", "studio", "ledger", "blueprint",
    ]);
    expect(schema.properties.unitSystem?.enum).toEqual(["metric", "imperial"]);
  });
});

describe("generate_worksheet_pack", () => {
  it("writes the PDF to the out dir and returns its absolute path", async () => {
    const stub = await okPdfStub();
    const outDir = makeOutDir();
    const result = await handleCallTool("generate_worksheet_pack", VALID_ARGS, cfg(stub.baseUrl, outDir));
    const text = textOf(result);

    expect(result.isError).toBeFalsy();
    const match = text.match(/(\/\S+\.pdf)/);
    expect(match, `no pdf path in: ${text}`).toBeTruthy();
    const path = match![1]!;
    expect(path.startsWith(outDir)).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path)).toEqual(PDF_BYTES);
    // Readable + timestamped: skill, grade and a date are all in the file name.
    expect(path).toMatch(/multiplication/);
    expect(path).toMatch(/grade-?4/);
    expect(path).toMatch(/\d{4}-\d{2}-\d{2}/);
    // One-line summary for the human, not a wall of JSON.
    expect(text).toMatch(/5 worksheet/);
  });

  it("creates the out dir when it does not exist yet", async () => {
    const stub = await okPdfStub();
    const outDir = join(makeOutDir(), "nested", "packs");
    const result = await handleCallTool("generate_worksheet_pack", VALID_ARGS, cfg(stub.baseUrl, outDir));
    expect(result.isError).toBeFalsy();
    expect(existsSync(outDir)).toBe(true);
  });

  it("sends the bearer key, JSON content type and only the fields the route reads", async () => {
    const stub = await okPdfStub();
    await handleCallTool(
      "generate_worksheet_pack",
      { ...VALID_ARGS, title: "Friday Fractions", nonsense: "ignore me" },
      cfg(stub.baseUrl),
    );
    const req = stub.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/api/generate");
    expect(req.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(req.headers["content-type"]).toMatch(/application\/json/);
    const body = JSON.parse(req.body);
    expect(body.skill).toBe("multiplication");
    expect(body.grade).toBe(4);
    expect(body.theme).toBe("teal");
    expect(body.title).toBe("Friday Fractions");
    // Unknown keys are dropped rather than forwarded.
    expect(body.nonsense).toBeUndefined();
    // Absent options are omitted entirely so the server's own defaults apply.
    expect("style" in body).toBe(false);
  });

  it("refuses to call the API at all when skill or grade is missing", async () => {
    const stub = await okPdfStub();
    const result = await handleCallTool("generate_worksheet_pack", { grade: 4 }, cfg(stub.baseUrl));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/skill/);
    expect(stub.requests).toHaveLength(0);
  });

  const errorCases: Array<[number, Record<string, unknown>, Record<string, string>, RegExp, RegExp]> = [
    [401, {}, {}, /revoked|wrong/i, /mathter\.ca\/account/],
    [402, { code: "over_limit" }, {}, /out of (worksheet )?credits|monthly/i, /pricing|next month|upgrade/i],
    [402, { code: "pro_style" }, {}, /style/i, /plan|upgrade/i],
    [403, {}, {}, /admin|organisation|organization/i, /account/i],
    [429, {}, { "Retry-After": "45" }, /too (fast|many)/i, /45 second/i],
    [429, {}, {}, /too (fast|many)/i, /wait/i],
    [503, {}, {}, /busy/i, /retry|again/i],
    [500, {}, {}, /server error/i, /not your request|try again/i],
  ];

  it.each(errorCases)("maps HTTP %i to its own actionable message", async (status, extra, headers, expected, advice) => {
    const stub = await (failingStub(status, extra, headers)());
    const result = await handleCallTool("generate_worksheet_pack", VALID_ARGS, cfg(stub.baseUrl));
    const text = textOf(result);
    expect(result.isError).toBe(true);
    expect(text).toMatch(expected);
    expect(text).toMatch(advice);
  });

  it("gives the two 402s different messages", async () => {
    const overLimit = await (failingStub(402, { code: "over_limit" })());
    const proStyle = await (failingStub(402, { code: "pro_style" })());
    const a = textOf(await handleCallTool("generate_worksheet_pack", VALID_ARGS, cfg(overLimit.baseUrl)));
    const b = textOf(await handleCallTool("generate_worksheet_pack", VALID_ARGS, cfg(proStyle.baseUrl)));
    expect(a).not.toEqual(b);
    expect(b).toMatch(/style/i);
  });

  it("writes nothing to disk when the request fails", async () => {
    const stub = await (failingStub(500)());
    const outDir = makeOutDir();
    const result = await handleCallTool("generate_worksheet_pack", VALID_ARGS, cfg(stub.baseUrl, outDir));
    expect(result.isError).toBe(true);
    expect(readdirSync(outDir)).toEqual([]);
  });

  it("reports an unreachable server without pretending the pack succeeded", async () => {
    const stub = await okPdfStub();
    const dead = stub.baseUrl.replace(/:(\d+)$/, (_m, p) => `:${Number(p) === 65535 ? 1 : Number(p) + 1}`);
    await stub.close();
    const result = await handleCallTool("generate_worksheet_pack", VALID_ARGS, cfg(dead));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/could not reach/i);
  });
});

describe("list_skills", () => {
  it("proxies GET /api/skills and formats the result for the model", async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ skills: [
        { key: "multiplication", label: "Multiplication", grades: [2, 3, 4, 5] },
        { key: "fractions", label: "Fractions", grades: [4, 5, 6] },
      ] }));
    });
    const result = await handleCallTool("list_skills", {}, cfg(stub.baseUrl));
    const text = textOf(result);
    expect(result.isError).toBeFalsy();
    expect(stub.requests[0]!.method).toBe("GET");
    expect(stub.requests[0]!.url).toBe("/api/skills");
    expect(text).toMatch(/multiplication/);
    expect(text).toMatch(/Fractions/);
    expect(text).toMatch(/4/);
  });

  it("does not send the API key to the public skills endpoint", async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ skills: [] }));
    });
    await handleCallTool("list_skills", {}, cfg(stub.baseUrl));
    expect(stub.requests[0]!.headers.authorization).toBeUndefined();
  });

  it("explains a rate limit instead of returning an empty list", async () => {
    const stub = await (failingStub(429, {}, { "Retry-After": "30" })());
    const result = await handleCallTool("list_skills", {}, cfg(stub.baseUrl));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/30 second/);
  });
});

describe("unknown tools", () => {
  it("names the tool it does not know", async () => {
    const result = await handleCallTool("delete_everything", {}, cfg("http://127.0.0.1:1"));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/delete_everything/);
  });
});

describe("the API key never escapes this process", () => {
  // The whole reason this package exists is that its output lands in a chat transcript the
  // teacher may paste into an email, a bug report, or another model. Not one byte of the key may
  // appear in anything we hand back or print.
  const leakChecks: Array<[string, () => Promise<Stub>]> = [
    ["200 success", okPdfStub],
    ["400", failingStub(400)],
    ["401", failingStub(401)],
    ["402 over_limit", failingStub(402, { code: "over_limit" })],
    ["402 pro_style", failingStub(402, { code: "pro_style" })],
    ["403", failingStub(403)],
    ["429", failingStub(429, {}, { "Retry-After": "12" })],
    ["500", failingStub(500)],
    ["503", failingStub(503)],
    ["418 (unmapped)", failingStub(418)],
  ];

  it.each(leakChecks)("never echoes the key for %s", async (_label, makeStub) => {
    const logs: string[] = [];
    for (const method of ["log", "error", "warn", "info", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args.join(" ")); });
    }
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      logs.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      logs.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    const stub = await makeStub();
    const outDir = makeOutDir();
    const gen = await handleCallTool("generate_worksheet_pack", VALID_ARGS, cfg(stub.baseUrl, outDir));
    const list = await handleCallTool("list_skills", {}, cfg(stub.baseUrl, outDir));

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();

    const everything = [textOf(gen), textOf(list), ...logs, JSON.stringify(gen), JSON.stringify(list)].join("\n");
    expect(everything).not.toContain(TEST_KEY);
    expect(everything).not.toContain(TEST_KEY.slice(8)); // not even the secret half, un-prefixed
    expect(everything).not.toMatch(/mk_live_[A-Za-z0-9]/); // no bearer-shaped token at all
  });

  it("redacts a key the server itself echoes back inside an error body", async () => {
    // The stub's 401 body literally contains "Bearer mk_live_...". If the implementation pastes a
    // server error straight into its tool output, this fails.
    const stub = await (failingStub(401)());
    const result = await handleCallTool("generate_worksheet_pack", VALID_ARGS, cfg(stub.baseUrl));
    const text = textOf(result);
    expect(stub.requests[0]!.headers.authorization).toBe(`Bearer ${TEST_KEY}`); // the stub really saw it
    expect(text).not.toContain(TEST_KEY);
  });

  it("never prints the key while failing to start", async () => {
    const stderr: string[] = [];
    await main(
      { MATHTER_API_KEY: TEST_KEY, MATHTER_BASE_URL: "not a url at all" },
      { stderr: (l) => stderr.push(l), exit: () => {} },
    );
    expect(stderr.join("\n")).not.toContain(TEST_KEY);
  });
});
