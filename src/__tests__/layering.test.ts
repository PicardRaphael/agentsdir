import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The layering contract of the CLI, enforced instead of documented: `core/`
 * owns the engine and must stay usable on its own, so it never reaches up into
 * the layers built on top of it. Without this test the direction only holds
 * until the next hurried import.
 */
const srcRoot = fileURLToPath(new URL("..", import.meta.url));

type Layer = "core" | "commands" | "packs" | "templates" | "icons" | "root";

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") {
        continue;
      }
      found.push(...sourceFiles(path));
    } else if (entry.name.endsWith(".ts")) {
      found.push(path);
    }
  }
  return found;
}

function layerOf(absolute: string): Layer {
  const rel = absolute.slice(srcRoot.length).split("\\").join("/");
  for (const layer of ["core", "commands", "packs", "templates", "icons"]) {
    if (rel.startsWith(`${layer}/`)) {
      return layer as Layer;
    }
  }
  return "root";
}

function internalImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/from "(\.[^"]+)"/g)].map((match) =>
    normalize(join(dirname(file), match[1] ?? "")),
  );
}

describe("architecture - layering", () => {
  it("Given the source tree, When core imports are inspected, Then core never depends on commands or packs", () => {
    const violations: string[] = [];
    for (const file of sourceFiles(srcRoot)) {
      if (layerOf(file) !== "core") {
        continue;
      }
      for (const target of internalImports(file)) {
        if (["commands", "packs"].includes(layerOf(target))) {
          violations.push(`${file} -> ${target}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("Given the source tree, When templates imports are inspected, Then templates never depend on commands or packs", () => {
    const violations: string[] = [];
    for (const file of sourceFiles(srcRoot)) {
      if (layerOf(file) !== "templates") {
        continue;
      }
      for (const target of internalImports(file)) {
        if (["commands", "packs"].includes(layerOf(target))) {
          violations.push(`${file} -> ${target}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("Given the source tree, When every file is inspected, Then no module imports itself through a cycle of two", () => {
    const imports = new Map<string, string[]>();
    for (const file of sourceFiles(srcRoot)) {
      imports.set(
        file,
        internalImports(file).map((target) => `${target}.ts`),
      );
    }
    const cycles: string[] = [];
    for (const [file, targets] of imports) {
      for (const target of targets) {
        if (imports.get(target)?.includes(`${file.replace(/\.ts$/, "")}.ts`)) {
          cycles.push(`${file} <-> ${target}`);
        }
      }
    }
    expect(cycles).toEqual([]);
  });
});
