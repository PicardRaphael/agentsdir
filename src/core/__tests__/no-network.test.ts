import dns from "node:dns";
import { readdir, readFile } from "node:fs/promises";
import net from "node:net";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCheck } from "../../commands/check.js";
import { runDoctor } from "../../commands/doctor.js";
import { runInit } from "../../commands/init.js";
import { initAnswers, makeTempDir } from "../../test-support/index.js";
import { measureContextBudget } from "../context-budget.js";

/**
 * Criterion: "this diagnosis opens no network connection, verified by a test"
 * — and, above it, "nothing leaves the repository, without exception".
 *
 * Two tests, because one of them alone proves half of it.
 *
 * The first lays a TRAP: every way out of the process throws. It is not a mock
 * — nothing is simulated, no behaviour is faked. If the diagnosis completes,
 * it went through none of them. Its weakness is that it only covers the code
 * this run happened to execute.
 *
 * The second reads the source instead of running it, and covers what no run
 * reaches — including `init` and `check`, which the criterion on leaving the
 * repository covers just as much as `doctor` does.
 */

/**
 * Everything a Node process goes through to reach the outside: `fetch`
 * (undici), the two DNS entry points, and `Socket.prototype.connect`, which
 * every TCP client ends up calling — `http`, `https` and `fetch` included. The
 * trap is laid for the duration of one call and lifted in `finally`, so a
 * failure inside it cannot leave the rest of the suite crippled.
 */
async function withNetworkTrapped<T>(run: () => Promise<T>): Promise<T> {
  const attempts: string[] = [];
  const saved = {
    connect: net.Socket.prototype.connect,
    lookup: dns.lookup,
    lookupPromise: dns.promises.lookup,
    fetch: globalThis.fetch,
  };
  const trap = (label: string) => (): never => {
    attempts.push(label);
    throw new Error(`network call attempted through ${label}`);
  };
  net.Socket.prototype.connect = trap("net.Socket.connect") as never;
  (dns as { lookup: unknown }).lookup = trap("dns.lookup");
  (dns.promises as { lookup: unknown }).lookup = trap("dns.promises.lookup");
  (globalThis as { fetch: unknown }).fetch = trap("fetch");
  try {
    return await run();
  } finally {
    net.Socket.prototype.connect = saved.connect;
    (dns as { lookup: unknown }).lookup = saved.lookup;
    (dns.promises as { lookup: unknown }).lookup = saved.lookupPromise;
    (globalThis as { fetch: unknown }).fetch = saved.fetch;
    expect(attempts, "the diagnosis reached for the network").toEqual([]);
  }
}

describe("Given a repository being diagnosed", () => {
  it("When every way out of the process throws, Then doctor still produces its report", async () => {
    const dir = await makeTempDir("no-network");
    await runInit(dir, initAnswers(), { dryRun: false });
    const result = await withNetworkTrapped(() =>
      runDoctor(dir, {
        symlinkSupport: () =>
          Promise.resolve({ supported: true, reason: "injected" }),
        gitSymlinks: () =>
          Promise.resolve({
            isGitRepo: true,
            coreSymlinks: "unset",
            materializedSymlinks: [],
          }),
        developerMode: () => Promise.resolve("not-applicable" as const),
        machineHarnesses: () => Promise.resolve([]),
      }),
    );
    // the two findings that carry the dates are exactly the ones a naive
    // implementation would have asked a registry for
    expect(result.findings.map((finding) => finding.rule)).toContain("cli-age");
    expect(result.findings.map((finding) => finding.rule)).toContain(
      "conventions-age",
    );
    expect(result.exitCode).toBe(0);
  });

  it("When every way out of the process throws, Then check and the context budget still run", async () => {
    const dir = await makeTempDir("no-network-check");
    await runInit(dir, initAnswers(), { dryRun: false });
    const { check, budget } = await withNetworkTrapped(async () => ({
      check: await runCheck(dir),
      budget: await measureContextBudget(dir),
    }));
    expect(check.exitCode).toBe(0);
    expect(budget.items.length).toBeGreaterThan(0);
  });
});

/** What a line has to contain to be reaching outside the machine. */
const NETWORK_APIS = [
  /\bfetch\s*\(/,
  /["']node:(?:http|https|net|dns|tls|dgram|http2)["']/,
  /\brequire\s*\(\s*["'](?:http|https|net|dns|tls|dgram|http2)["']\s*\)/,
  /\bXMLHttpRequest\b/,
  /\bnew\s+WebSocket\b/,
];

async function sourceFiles(dir: string, found: string[]): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "test-support") {
        continue;
      }
      await sourceFiles(path, found);
    } else if (entry.name.endsWith(".ts")) {
      found.push(path);
    }
  }
  return found;
}

describe("Given the source of the CLI", () => {
  it("When it is read line by line, Then no command reaches for the network at all", async () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const files = await sourceFiles(src, []);
    expect(files.length).toBeGreaterThan(30);
    const offenders: string[] = [];
    for (const file of files) {
      const lines = (await readFile(file, "utf8")).split("\n");
      lines.forEach((line, index) => {
        if (NETWORK_APIS.some((api) => api.test(line))) {
          offenders.push(`${relative(src, file)}:${index + 1} ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("When the runtime dependencies are declared, Then none of them is a network client", async () => {
    const root = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
    );
    const manifest = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    // the four are audited by hand in docs/architecture.md; this guard is what
    // catches a fifth arriving, which is when the audit would have to be redone
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      "@clack/prompts",
      "citty",
      "smol-toml",
      "yaml",
    ]);
  });
});
