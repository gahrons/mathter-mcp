// The official MCP Registry entry (server.json) must name the exact npm release, and the registry
// refuses a release whose package.json lacks the matching mcpName. Bumping one file and not the
// others would publish a registry entry that points at the wrong (or a missing) version.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (f: string) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"));
const pkg = read("package.json");
const server = read("server.json");
const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

describe("registry metadata stays in step with the package", () => {
  it("server.json names this package, at this version, under the mathter.ca namespace", () => {
    expect(server.name).toBe("ca.mathter/mathter");
    expect(pkg.mcpName).toBe(server.name);
    expect(server.version).toBe(pkg.version);
    expect(server.packages).toHaveLength(1);
    expect(server.packages[0]).toMatchObject({ registryType: "npm", identifier: pkg.name, version: pkg.version });
  });

  it("the version the server reports matches package.json", () => {
    expect(src).toContain(`const VERSION = "${pkg.version}";`);
  });

  it("the registry description fits its 100-character limit", () => {
    expect(server.description.length).toBeLessThanOrEqual(100);
  });

  it("MATHTER_API_KEY is declared required and secret", () => {
    const key = server.packages[0].environmentVariables.find((e: { name: string }) => e.name === "MATHTER_API_KEY");
    expect(key).toMatchObject({ isRequired: true, isSecret: true });
  });
});
