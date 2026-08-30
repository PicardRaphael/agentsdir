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

/**
 * Resolved paths of the internal imports of `file`, as .ts source paths —
 * imports are written with the emitted `.js` extension. `typeOnly: false` drops
 * `import type`, which the compiler erases: it cannot create a runtime cycle.
 */
function internalImports(
  file: string,
  options: { typeOnly: boolean } = { typeOnly: true },
): string[] {
  const source = readFileSync(file, "utf8");
  const pattern = options.typeOnly
    ? /(?:^|\n)import\s(?:[\s\S]*?)from "(\.[^"]+)"/g
    : /(?:^|\n)import\s(?!type\s)(?:[\s\S]*?)from "(\.[^"]+)"/g;
  return [...source.matchAll(pattern)].map((match) =>
    normalize(join(dirname(file), (match[1] ?? "").replace(/\.js$/, ".ts"))),
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

  it("Given the source tree, When value imports are inspected, Then no two modules import each other at runtime", () => {
    const imports = new Map<string, string[]>();
    for (const file of sourceFiles(srcRoot)) {
      imports.set(file, internalImports(file, { typeOnly: false }));
    }
    const cycles: string[] = [];
    for (const [file, targets] of imports) {
      for (const target of targets) {
        if (imports.get(target)?.includes(file) === true) {
          cycles.push(`${file} <-> ${target}`);
        }
      }
    }
    expect(cycles).toEqual([]);
  });
});
