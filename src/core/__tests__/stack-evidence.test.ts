import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { detectStack } from "../detect.js";
import { renderAgentsMd } from "../../templates/agents-md.js";
import { makeTempDir, runCli } from "../../test-support/index.js";

const execFileAsync = promisify(execFile);

/**
 * An `AGENTS.md` stating `npm test` in a repo that has no such script is worse
 * than an empty one: the agent believes it. So a command is written down only
 * where the repository proves it — a script it declares, a tool it depends on,
 * a subcommand of the toolchain its marker file declares. Everything else is
 * the stack's convention, and reaches the file marked as to be completed.
 */
async function repoWith(
  prefix: string,
  files: Record<string, string>,
): Promise<string> {
  const dir = await makeTempDir(prefix);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, "utf8");
  }
  return dir;
}

describe("35 - detected commands are read, never supposed", () => {
  it("Given a package.json with no scripts, When detectStack reads it, Then no command is asserted and the conventions stay unverified", async () => {
    const dir = await repoWith("stack-node-bare", { "package.json": "{}\n" });

    const [node] = await detectStack(dir);

    expect(node?.commands).toEqual({});
    expect(node?.unverified).toEqual({
      dev: "npm run dev",
      test: "npm test",
      lint: "npm run lint",
    });
  });

  it("Given a package.json declaring test and dev, When detectStack reads it, Then exactly those are asserted", async () => {
    const dir = await repoWith("stack-node-scripts", {
      "package.json": '{"scripts": {"dev": "vite", "test": "vitest run"}}\n',
    });

    const [node] = await detectStack(dir);

    expect(node?.commands).toEqual({ dev: "npm run dev", test: "npm test" });
    expect(node?.unverified).toEqual({ lint: "npm run lint" });
  });

  it("Given a pyproject.toml naming pytest and ruff, When detectStack reads it, Then both are asserted; a bare one asserts nothing", async () => {
    const declared = await repoWith("stack-python-declared", {
      "pyproject.toml":
        '[project]\nname = "demo"\n\n[dependency-groups]\ndev = ["pytest>=8", "ruff"]\n',
    });
    const bare = await repoWith("stack-python-bare", {
      "pyproject.toml": '[project]\nname = "demo"\n',
    });

    const [withTools] = await detectStack(declared);
    const [without] = await detectStack(bare);

    expect(withTools?.commands).toEqual({
      test: "pytest",
      lint: "ruff check .",
    });
    expect(without?.commands).toEqual({});
    expect(without?.unverified).toEqual({
      test: "pytest",
      lint: "ruff check .",
    });
  });

  it("Given a Cargo.toml, When detectStack reads it, Then only the cargo built-in is asserted and clippy stays unverified", async () => {
    // `cargo test` ships with cargo; `cargo clippy` is a separate component a
    // Cargo.toml does not promise
    const dir = await repoWith("stack-rust", {
      "Cargo.toml": '[package]\nname = "demo"\n',
    });

    const [rust] = await detectStack(dir);

    expect(rust?.commands).toEqual({ test: "cargo test" });
    expect(rust?.unverified).toEqual({ lint: "cargo clippy" });
  });

  it("Given a Gemfile declaring rubocop, When detectStack reads it, Then the lint command is asserted and the rake convention is not", async () => {
    const dir = await repoWith("stack-ruby", {
      Gemfile: 'source "https://rubygems.org"\ngem "rubocop", require: false\n',
    });

    const [ruby] = await detectStack(dir);

    expect(ruby?.commands).toEqual({ lint: "bundle exec rubocop" });
    expect(ruby?.unverified).toEqual({ test: "bundle exec rake test" });
  });

  it("Given a malformed marker file, When detectStack reads it, Then it proves nothing instead of failing", async () => {
    const dir = await repoWith("stack-malformed", {
      "package.json": "{ not json at all",
      "pyproject.toml": "[project\nbroken",
    });

    const stacks = await detectStack(dir);

    expect(stacks.map((stack) => stack.id)).toEqual(["node", "python"]);
    for (const stack of stacks) {
      expect(stack.commands).toEqual({});
    }
  });

  it("Given unverified commands, When AGENTS.md is rendered, Then the row is marked to fill in and the command never appears", async () => {
    const source = renderAgentsMd(
      {
        productName: "demo",
        description: "A demo product.",
        stacks: ["python"],
        commands: {},
        unverified: { test: "pytest", lint: "ruff check ." },
      },
      [],
    );

    expect(source).toContain("| test | _to fill in_ |");
    expect(source).toContain("| lint | _to fill in_ |");
    // the whole point: the guess is nowhere in the file an agent will believe
    expect(source).not.toContain("pytest");
    expect(source).not.toContain("ruff check");
  });

  it("Given `init --yes` on a Python repo with no declared tools, When it runs, Then AGENTS.md invents no command", async () => {
    const dir = await repoWith("stack-init-python", {
      "pyproject.toml": '[project]\nname = "demo"\n',
    });
    await execFileAsync("git", ["-C", dir, "init"]);

    await runCli(dir, ["init", "--yes"]);

    const agents = await readFile(join(dir, "AGENTS.md"), "utf8");
    expect(agents).toContain("| test | _to fill in_ |");
    expect(agents).not.toContain("pytest");
    expect(agents).not.toContain("ruff");
    // the rule installed alongside it must not assert them either
    const tasksRule = await readFile(
      join(dir, ".agents", "rules", "tasks.md"),
      "utf8",
    );
    expect(tasksRule).not.toContain("pytest");
    expect(tasksRule).not.toContain("ruff");
  });
});
