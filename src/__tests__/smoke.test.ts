import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { cliPath } from "../test-support/index.js";

const execFileAsync = promisify(execFile);
const distDir = fileURLToPath(new URL("../../dist", import.meta.url));

describe("01 - package skeleton (walking skeleton)", () => {
  it("Given the built bundle, When node dist/cli.js --help runs, Then it prints the CLI help and exits with code 0", async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      cliPath,
      "--help",
    ]);
    const output = `${stdout}${stderr}`;
    expect(output).toContain("agentsdir");
    expect(output.toUpperCase()).toContain("USAGE");
  });

  it("Given the source tree, When npm run build runs, Then dist/ contains a single cli.js bundle", async () => {
    await expect(readdir(distDir)).resolves.toEqual(["cli.js"]);
  });

  it("Given the bundle is the npx entry point, When it is generated, Then its first line is the node shebang", async () => {
    const bundle = await readFile(cliPath, "utf8");
    expect(bundle.split("\n", 1)[0]).toBe("#!/usr/bin/env node");
  });
});
