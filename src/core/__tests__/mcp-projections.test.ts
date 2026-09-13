import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runCheck } from "../../commands/check.js";
import { runInit } from "../../commands/init.js";
import { runSync } from "../../commands/sync.js";
import { EXIT_CODES } from "../../exit-codes.js";
import {
  initAnswers,
  makeTempDir,
  pathExists,
} from "../../test-support/index.js";
import { MANIFEST_FILE } from "../manifest.js";
import { MCP_PROJECTIONS, MCP_SOURCE } from "../mcp.js";
import type { Violation } from "../validate.js";

const execFileAsync = promisify(execFile);

/**
 * Task 27 — MCP servers declared once, projected three times.
 *
 * A repository that declares MCP servers had to say it three times, in three
 * formats, and keep them in step by hand: exactly the problem this product
 * solves for rules, skills and hooks, and the only one of the four it did not
 * treat.
 *
 * Two properties matter more than the rest and are asserted everywhere below.
 * The user's own servers are never touched — a `.mcp.json` usually holds
 * entries someone added by hand, sometimes with a token in them. And no secret
 * value ever reaches a versioned file: the declaration carries the *names* of
 * environment variables, and each harness turns a name into a value its own way
 * at run time.
 */

async function repo(harnesses?: string[]): Promise<string> {
  const dir = await makeTempDir("mcp");
  await execFileAsync("git", ["-C", dir, "init"]);
  await runInit(
    dir,
    initAnswers({
      packs: ["core"],
      ...(harnesses === undefined ? {} : { harnesses }),
    }),
    { dryRun: false },
  );
  return dir;
}

const TWO_SERVERS = [
  "[servers.context7]",
  'type = "stdio"',
  'command = "npx"',
  'args = ["-y", "@upstash/context7-mcp"]',
  'env = ["CONTEXT7_API_KEY"]',
  "",
  "[servers.figma]",
  'type = "http"',
  'url = "https://mcp.figma.com/mcp"',
  'headers = { "X-Figma-Token" = "FIGMA_OAUTH_TOKEN" }',
  "",
].join("\n");

const ONE_SERVER = [
  "[servers.context7]",
  'type = "stdio"',
  'command = "npx"',
  'args = ["-y", "@upstash/context7-mcp"]',
  'env = ["CONTEXT7_API_KEY"]',
  "",
].join("\n");

async function declare(dir: string, toml: string): Promise<void> {
  await writeFile(join(dir, ...MCP_SOURCE.split("/")), toml, "utf8");
}

async function read(dir: string, rel: string): Promise<string> {
  return readFile(join(dir, ...rel.split("/")), "utf8");
}

async function json(
  dir: string,
  rel: string,
): Promise<Record<string, Record<string, unknown>>> {
  return JSON.parse(await read(dir, rel)) as Record<
    string,
    Record<string, unknown>
  >;
}

async function check(dir: string): Promise<Violation[]> {
  return (await runCheck(dir, { hooks: { timeoutMs: 5000 } })).violations;
}

function ruled(violations: Violation[], rule: string): Violation[] {
  return violations.filter((violation) => violation.rule === rule);
}

describe("27 - one declaration, three projections", () => {
  it("Given two servers declared in .agents/mcp.toml, When sync runs, Then each harness gets them in its own verified format", async () => {
    const dir = await repo();
    await declare(dir, TWO_SERVERS);

    expect((await runSync(dir, { dryRun: false })).exitCode).toBe(
      EXIT_CODES.ok,
    );

    // Claude Code: explicit `type`, `${VAR}` expansion
    const claude = await json(dir, MCP_PROJECTIONS.claude);
    expect(claude["mcpServers"]?.["context7"]).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
      env: { CONTEXT7_API_KEY: "${CONTEXT7_API_KEY}" },
    });
    expect(claude["mcpServers"]?.["figma"]).toEqual({
      type: "http",
      url: "https://mcp.figma.com/mcp",
      headers: { "X-Figma-Token": "${FIGMA_OAUTH_TOKEN}" },
    });

    // Cursor: same envelope, no `type` field, `${env:VAR}` expansion
    const cursor = await json(dir, MCP_PROJECTIONS.cursor);
    expect(cursor["mcpServers"]?.["context7"]).toEqual({
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
      env: { CONTEXT7_API_KEY: "${env:CONTEXT7_API_KEY}" },
    });
    expect(cursor["mcpServers"]?.["figma"]).toEqual({
      url: "https://mcp.figma.com/mcp",
      headers: { "X-Figma-Token": "${env:FIGMA_OAUTH_TOKEN}" },
    });

    // Codex: TOML tables, and no interpolation at all — `env_vars` forwards
    // named variables, `env_http_headers` maps a header to a variable name
    const codex = await read(dir, MCP_PROJECTIONS.codex);
    expect(codex).toContain("[mcp_servers.context7]");
    expect(codex).toContain('command = "npx"');
    expect(codex).toContain('env_vars = ["CONTEXT7_API_KEY"]');
    expect(codex).toContain(
      'env_http_headers = { "X-Figma-Token" = "FIGMA_OAUTH_TOKEN" }',
    );
    // `env` would set a literal value; it must never be what we write
    expect(codex).not.toContain("[mcp_servers.context7.env]");
  });

  it("Given a repository that declares no server, When sync runs, Then no MCP file is created at all", async () => {
    // the normal state of most repositories: an absent declaration is a
    // non-event, not an empty `.mcp.json` appearing in someone's diff
    const dir = await repo();

    const result = await runSync(dir, { dryRun: false });

    expect(result.exitCode).toBe(EXIT_CODES.ok);
    for (const path of Object.values(MCP_PROJECTIONS)) {
      expect(await pathExists(join(dir, ...path.split("/")))).toBe(false);
    }
    expect(await read(dir, MANIFEST_FILE)).not.toContain("[mcp]");
  });

  it("Given a server the user added by hand, When sync runs, Then it survives untouched", async () => {
    const dir = await repo();
    await declare(dir, TWO_SERVERS);
    await runSync(dir, { dryRun: false });
    const mine = await json(dir, MCP_PROJECTIONS.claude);
    mine["mcpServers"]!["mine-by-hand"] = {
      type: "stdio",
      command: "node",
      args: ["./tools/my-server.mjs"],
      env: { MY_SECRET: "s3cr3t-typed-by-hand" },
    };
    await writeFile(
      join(dir, MCP_PROJECTIONS.claude),
      `${JSON.stringify(mine, null, 2)}\n`,
      "utf8",
    );

    await runSync(dir, { dryRun: false });

    const after = await json(dir, MCP_PROJECTIONS.claude);
    expect(after["mcpServers"]?.["mine-by-hand"]).toEqual({
      type: "stdio",
      command: "node",
      args: ["./tools/my-server.mjs"],
      env: { MY_SECRET: "s3cr3t-typed-by-hand" },
    });
    expect(Object.keys(after["mcpServers"] ?? {}).sort()).toEqual([
      "context7",
      "figma",
      "mine-by-hand",
    ]);
  });

  it("Given a Codex configuration of its own, When sync runs, Then every byte the user wrote is preserved", async () => {
    const dir = await repo();
    await mkdir(join(dir, ".codex"), { recursive: true });
    const theirs = 'model = "o3"\napproval_policy = "on-request"\n';
    await writeFile(join(dir, MCP_PROJECTIONS.codex), theirs, "utf8");
    await declare(dir, TWO_SERVERS);

    await runSync(dir, { dryRun: false });

    const codex = await read(dir, MCP_PROJECTIONS.codex);
    expect(codex.startsWith(theirs)).toBe(true);
    expect(codex).toContain("# agentsdir:begin mcp");
    // and the block warns about the one TOML rule that could break their file
    expect(codex).toContain("Keep this block last");
  });

  it("Given a server dropped from the source, When sync runs, Then it leaves all three projections", async () => {
    const dir = await repo();
    await declare(dir, TWO_SERVERS);
    await runSync(dir, { dryRun: false });
    await declare(dir, ONE_SERVER);

    await runSync(dir, { dryRun: false });

    expect(
      Object.keys(
        (await json(dir, MCP_PROJECTIONS.claude))["mcpServers"] ?? {},
      ),
    ).toEqual(["context7"]);
    expect(
      Object.keys(
        (await json(dir, MCP_PROJECTIONS.cursor))["mcpServers"] ?? {},
      ),
    ).toEqual(["context7"]);
    const codex = await read(dir, MCP_PROJECTIONS.codex);
    expect(codex).toContain("[mcp_servers.context7]");
    expect(codex).not.toContain("figma");
    expect((await check(dir)).length).toBe(0);
  });

  it("Given every server dropped, When sync runs, Then the managed block leaves the Codex file and the manifest forgets them", async () => {
    const dir = await repo();
    await declare(dir, TWO_SERVERS);
    await runSync(dir, { dryRun: false });
    await declare(dir, "\n");

    await runSync(dir, { dryRun: false });

    expect(await read(dir, MCP_PROJECTIONS.codex)).not.toContain("agentsdir");
    expect(await read(dir, MCP_PROJECTIONS.claude)).not.toContain("context7");
    expect(await read(dir, MANIFEST_FILE)).not.toContain("[mcp]");
  });

  it("Given a harness no longer enabled, When sync runs, Then its servers are removed rather than left configured", async () => {
    // the mistake the hook registries had to fix: skipping a disabled harness
    // left its hooks registered and running. A server is the same — it would
    // keep starting on a harness the repository no longer declares.
    const dir = await repo();
    await declare(dir, TWO_SERVERS);
    await runSync(dir, { dryRun: false });
    const manifest = join(dir, MANIFEST_FILE);
    await writeFile(
      manifest,
      (await readFile(manifest, "utf8")).replace(
        /enabled = \[[^\]]*\]/,
        'enabled = [ "claude" ]',
      ),
      "utf8",
    );

    await runSync(dir, { dryRun: false });

    expect(
      Object.keys(
        (await json(dir, MCP_PROJECTIONS.cursor))["mcpServers"] ?? {},
      ),
    ).toEqual([]);
    expect(await read(dir, MCP_PROJECTIONS.codex)).not.toContain("mcp_servers");
    // and the harness that is still enabled keeps them
    expect(
      Object.keys(
        (await json(dir, MCP_PROJECTIONS.claude))["mcpServers"] ?? {},
      ),
    ).toEqual(["context7", "figma"]);
  });
});

describe("27 - check sees the drift and names the fix", () => {
  it("Given a projection edited by hand, When check runs, Then it names the file and the command that repairs it", async () => {
    const dir = await repo();
    await declare(dir, TWO_SERVERS);
    await runSync(dir, { dryRun: false });
    const claude = await json(dir, MCP_PROJECTIONS.claude);
    (claude["mcpServers"]!["context7"] as Record<string, unknown>)["command"] =
      "nope";
    await writeFile(
      join(dir, MCP_PROJECTIONS.claude),
      `${JSON.stringify(claude, null, 2)}\n`,
      "utf8",
    );

    const drift = ruled(await check(dir), "mcp-projection-drift");

    expect(drift[0]?.path).toBe(MCP_PROJECTIONS.claude);
    expect(drift[0]?.message).toContain(MCP_SOURCE);
    expect(drift[0]?.message).toContain("agentsdir sync");
  });

  it("Given a harness disabled with its servers still declared, When check runs, Then it says they keep running", async () => {
    const dir = await repo();
    await declare(dir, TWO_SERVERS);
    await runSync(dir, { dryRun: false });
    const manifest = join(dir, MANIFEST_FILE);
    await writeFile(
      manifest,
      (await readFile(manifest, "utf8")).replace(
        /enabled = \[[^\]]*\]/,
        'enabled = [ "claude" ]',
      ),
      "utf8",
    );

    const drift = ruled(await check(dir), "mcp-projection-drift");

    expect(
      drift.some((violation) =>
        violation.message.includes("no longer in `[harness] enabled`"),
      ),
    ).toBe(true);
  });

  it("Given a declaration that is not valid TOML, When check runs, Then it refuses by name instead of projecting a guess", async () => {
    const dir = await repo();
    await declare(dir, "[servers.broken\n");

    const problems = ruled(await check(dir), "mcp-source-invalid");

    expect(problems[0]?.path).toBe(MCP_SOURCE);
    expect(problems[0]?.message).toContain("not valid TOML");
  });

  it("Given a key written after the managed block, When check runs, Then it says TOML would attach it to the server above", async () => {
    // the one way this design can break a user's file, so it is an invariant
    // rather than a comment: in TOML everything after a table header belongs
    // to that table
    const dir = await repo();
    await declare(dir, TWO_SERVERS);
    await runSync(dir, { dryRun: false });
    const codex = join(dir, MCP_PROJECTIONS.codex);
    await writeFile(
      codex,
      `${await readFile(codex, "utf8")}\nmodel = "o3"\n`,
      "utf8",
    );

    const problems = ruled(await check(dir), "mcp-block-not-last");

    expect(problems[0]?.message).toContain("`model`");
    expect(problems[0]?.message).toContain("belongs to the server table");
  });

  it("Given a sync that just ran, When check runs, Then nothing about MCP is reported", async () => {
    const dir = await repo();
    await declare(dir, TWO_SERVERS);
    await runSync(dir, { dryRun: false });

    const violations = await check(dir);

    expect(violations.filter((v) => v.rule.startsWith("mcp-"))).toEqual([]);
  });
});

describe("27 - a secret never reaches a versioned file", () => {
  it("Given a value where a variable name belongs, When check runs, Then it is refused and never projected", async () => {
    const dir = await repo();
    await declare(
      dir,
      [
        "[servers.leaky]",
        'type = "stdio"',
        'command = "node"',
        'env = ["sk-live-0123456789abcdef"]',
        "",
      ].join("\n"),
    );

    const problems = ruled(await check(dir), "mcp-secret-value");

    expect(problems).toHaveLength(1);
    expect(problems[0]?.path).toBe(MCP_SOURCE);
    expect(problems[0]?.message).toContain("versioned");
    // the report itself must not echo the suspected secret whole
    expect(problems[0]?.message).not.toContain("0123456789abcdef");
  });

  it("Given a header carrying a value rather than a variable name, When check runs, Then it is refused too", async () => {
    const dir = await repo();
    await declare(
      dir,
      [
        "[servers.leaky]",
        'type = "http"',
        'url = "https://example.test/mcp"',
        'headers = { "Authorization" = "Bearer sk-live-abcdef" }',
        "",
      ].join("\n"),
    );

    const problems = ruled(await check(dir), "mcp-secret-value");

    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain("Authorization");
  });

  it("Given servers projected to all three harnesses, When the files are read, Then every secret position holds a reference, never a value", async () => {
    const dir = await repo();
    await declare(dir, TWO_SERVERS);
    await runSync(dir, { dryRun: false });

    // the positive half of the guarantee: what is written is a reference the
    // harness resolves at run time, in each harness's own dialect
    const claude = await read(dir, MCP_PROJECTIONS.claude);
    expect(claude).toContain('"CONTEXT7_API_KEY": "${CONTEXT7_API_KEY}"');
    const cursor = await read(dir, MCP_PROJECTIONS.cursor);
    expect(cursor).toContain('"CONTEXT7_API_KEY": "${env:CONTEXT7_API_KEY}"');
    const codex = await read(dir, MCP_PROJECTIONS.codex);
    expect(codex).toContain('env_vars = ["CONTEXT7_API_KEY"]');

    // and nothing anywhere looks like a credential
    for (const path of Object.values(MCP_PROJECTIONS)) {
      expect(await read(dir, path)).not.toMatch(/sk-|Bearer |secret/i);
    }
  });
});
