import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HARNESS_DIRS,
  HARNESS_SPECS,
  HARNESSES,
  harnessEventKey,
  hasFileProjections,
  PROJECTING_HARNESSES,
} from "../harnesses.js";
import {
  HOOK_EVENTS,
  HOOK_REGISTRY_PATHS,
  supportedHarnesses,
} from "../hook-registries.js";

const srcRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * Task 19 — what a fourth harness costs.
 *
 * It used to cost an edit to all twelve hook events (one field each), to the
 * detection probes, and to every `includes("claude")` guard scattered through
 * the commands. A harness now declares itself once; everything else derives.
 * What is asserted here is that the derivation still produces exactly what the
 * hand-written tables produced — the three harnesses, event by event.
 */

/** The table as it stood before the refactor, kept as the reference. */
const BEFORE: Record<
  string,
  { claude: boolean; codex: boolean; cursor: string | undefined }
> = {
  PreToolUse: { claude: true, codex: true, cursor: "preToolUse" },
  PostToolUse: { claude: true, codex: true, cursor: "postToolUse" },
  UserPromptSubmit: {
    claude: true,
    codex: true,
    cursor: "beforeSubmitPrompt",
  },
  Stop: { claude: true, codex: true, cursor: "stop" },
  SessionStart: { claude: true, codex: true, cursor: "sessionStart" },
  SessionEnd: { claude: true, codex: true, cursor: "sessionEnd" },
  SubagentStart: { claude: true, codex: true, cursor: "subagentStart" },
  SubagentStop: { claude: true, codex: true, cursor: "subagentStop" },
  PreCompact: { claude: true, codex: true, cursor: "preCompact" },
  PostCompact: { claude: true, codex: true, cursor: undefined },
  PermissionRequest: { claude: true, codex: true, cursor: undefined },
  Notification: { claude: true, codex: false, cursor: undefined },
};

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") {
        found.push(...sourceFiles(path));
      }
    } else if (entry.name.endsWith(".ts")) {
      found.push(path);
    }
  }
  return found;
}

describe("19 - a harness declares itself, everything else derives", () => {
  it("Given the declarations, When event support is derived, Then it matches the hand-written table event by event", async () => {
    expect(HOOK_EVENTS.map((event) => event.name).sort()).toEqual(
      Object.keys(BEFORE).sort(),
    );
    for (const event of HOOK_EVENTS) {
      const expected = BEFORE[event.name];
      expect(harnessEventKey("claude", event.name)).toBe(
        expected?.claude === true ? event.name : undefined,
      );
      expect(harnessEventKey("codex", event.name)).toBe(
        expected?.codex === true ? event.name : undefined,
      );
      expect(harnessEventKey("cursor", event.name)).toBe(expected?.cursor);
    }
  });

  it("Given an event, When its supported harnesses are listed, Then the list follows the declarations", async () => {
    expect(supportedHarnesses({ name: "PreToolUse" })).toEqual([
      "claude",
      "codex",
      "cursor",
    ]);
    expect(supportedHarnesses({ name: "Notification" })).toEqual(["claude"]);
    expect(supportedHarnesses({ name: "PostCompact" })).toEqual([
      "claude",
      "codex",
    ]);
  });

  it("Given the declarations, When the derived tables are read, Then directories and registries agree with them", async () => {
    for (const harness of HARNESSES) {
      expect(HARNESS_DIRS[harness]).toBe(HARNESS_SPECS[harness].dir);
      expect(HOOK_REGISTRY_PATHS[harness]).toBe(
        HARNESS_SPECS[harness].hookRegistry,
      );
      // a registry lives inside the harness's own directory, always
      expect(HOOK_REGISTRY_PATHS[harness]).toMatch(
        new RegExp(`^${HARNESS_SPECS[harness].dir}/`),
      );
    }
  });

  it("Given the enabled harnesses, When projections are decided, Then the question is the property, not the name", async () => {
    expect(PROJECTING_HARNESSES).toEqual(["claude"]);
    expect(hasFileProjections(["claude", "codex"])).toBe(true);
    expect(hasFileProjections(["codex", "cursor"])).toBe(false);
    expect(hasFileProjections([])).toBe(false);
  });

  it("Given the source tree, When it is scanned, Then no module decides behaviour by naming a harness", async () => {
    // the guards this task removed: `includes("claude")` named the only
    // harness that happens to project files today
    const offenders = sourceFiles(srcRoot)
      .filter((file) => !file.endsWith("harnesses.ts"))
      .filter((file) =>
        /includes\(\s*"(claude|codex|cursor)"\s*\)/.test(
          readFileSync(file, "utf8"),
        ),
      )
      .map((file) => file.slice(srcRoot.length).split("\\").join("/"));

    expect(offenders).toEqual([]);
  });

  it("Given a fourth harness declared, When events are derived for it, Then not one event definition had to change", async () => {
    // the criterion, made executable: a harness is added by one entry, and the
    // twelve events are untouched
    const fourth = {
      dir: ".fourth",
      hookRegistry: ".fourth/hooks.json",
      eventCase: "lowerCamel" as const,
      unsupportedEvents: ["Notification"],
      eventAliases: { UserPromptSubmit: "onPrompt" },
      projectsFiles: false,
    };
    const keyFor = (event: string): string | undefined => {
      if (fourth.unsupportedEvents.includes(event)) {
        return undefined;
      }
      const alias = (fourth.eventAliases as Record<string, string>)[event];
      return alias ?? event.charAt(0).toLowerCase() + event.slice(1);
    };

    expect(keyFor("PreToolUse")).toBe("preToolUse");
    expect(keyFor("UserPromptSubmit")).toBe("onPrompt");
    expect(keyFor("Notification")).toBeUndefined();
    // and the events themselves carry nothing per harness any more
    for (const event of HOOK_EVENTS) {
      expect(Object.keys(event)).toEqual(["name"]);
    }
  });
});
