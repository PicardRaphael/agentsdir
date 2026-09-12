import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  HOOKS_DIR,
  listAttributedHookScripts,
  type HookEventSpec,
} from "./hook-registries.js";

/**
 * Invariant 15 — hook script protocol. The registry passes prove a script is
 * *declared* to the harnesses; nothing proved it could actually run. A hook
 * that crashes on its first payload, or answers free text where the harness
 * expects JSON, is registered, launched at every event, and fails in a place
 * the user never looks — so `check` invokes each script once, dry, and holds
 * its answer to the protocol the generated template documents.
 *
 * The script belongs to the repository being checked, not to a remote: running
 * it is running the user's own code. It is still bounded on every axis — a wall
 * clock, a capped output, stdin closed right after the sample payload, and not
 * one environment variable added.
 */

/**
 * Wall-clock budget of one dry invocation. `check` runs in CI: a hook that
 * never returns must cost seconds and a named violation, never a hung build.
 */
export const HOOK_PROBE_TIMEOUT_MS = 5000;

/**
 * The `session_id` every probe payload carries. `check` invokes each hook
 * script for real, so a script with a side effect — the usage pack writes a
 * journal line — would act on every check, in CI included. The probe adds no
 * environment variable on purpose (see the note above `invoke`), so the signal
 * travels in the payload instead: a script that must stay inert under `check`
 * tests this value and exits. Exported so the scripts that filter on it and
 * the payload that carries it cannot drift apart.
 */
export const HOOK_PROBE_SESSION_ID = "agentsdir-check";

/**
 * Beyond this, the answer is already a protocol violation (the contract is an
 * empty stdout or one JSON object) — reading further would only grow the cost.
 */
const HOOK_PROBE_MAX_OUTPUT = 1024 * 1024;

/**
 * The exit codes the template documents: 0 continues, 2 blocks. "Anything else
 * is a non-blocking error" describes what the harness does with a crash, not a
 * contract a script may claim — on a sample payload, any other code is the
 * script falling over before it decided anything.
 */
const DOCUMENTED_EXIT_CODES = new Set([0, 2]);

export interface HookProtocolProblem {
  /** Repo-relative path of the offending script. */
  path: string;
  rule:
    | "hook-protocol-timeout"
    | "hook-protocol-stdout"
    | "hook-protocol-exit"
    | "hook-protocol-crash";
  message: string;
}

export interface HookProbeOptions {
  /** Overridable so tests can prove the bound without paying for it. */
  timeoutMs?: number;
}

/**
 * Invokes every attributable script of `.agents/hooks/` once, in file-name
 * order, with the sample payload of its event on stdin. Returns one problem per
 * violated clause; an empty array means the whole directory honours the
 * protocol.
 */
export async function probeHookScripts(
  root: string,
  options: HookProbeOptions = {},
): Promise<HookProtocolProblem[]> {
  let scripts;
  try {
    scripts = await listAttributedHookScripts(root);
  } catch {
    // an unreadable hooks directory is the business of `sync`, which refuses
    // rather than deregistering what it cannot see — not of this probe
    return [];
  }
  const timeoutMs = options.timeoutMs ?? HOOK_PROBE_TIMEOUT_MS;
  const problems: HookProtocolProblem[] = [];
  for (const script of scripts) {
    // sequential on purpose: a repository with twenty hooks must not spawn
    // twenty node processes at once inside a CI container
    problems.push(
      ...describe(
        `${HOOKS_DIR}/${script.file}`,
        await invoke(
          root,
          script.file,
          sampleHookPayload(script.event),
          timeoutMs,
        ),
        timeoutMs,
      ),
    );
  }
  return problems;
}

/**
 * The sample payload of an event: fixed bytes, no clock and no random value, so
 * two runs of `check` send a hook exactly the same input. The shape follows the
 * envelope the three harnesses share (`hook_event_name` plus the fields of the
 * event), which is what the generated template parses.
 */
export function sampleHookPayload(event: HookEventSpec): string {
  const payload: Record<string, unknown> = {
    session_id: HOOK_PROBE_SESSION_ID,
    transcript_path: "",
    cwd: ".",
    hook_event_name: event.name,
  };
  if (event.name === "PreToolUse" || event.name === "PostToolUse") {
    payload["tool_name"] = "Read";
    payload["tool_input"] = {};
  }
  if (event.name === "PostToolUse") {
    payload["tool_response"] = {};
  }
  if (event.name === "UserPromptSubmit") {
    payload["prompt"] = "";
  }
  if (event.name === "Stop" || event.name === "SubagentStop") {
    payload["stop_hook_active"] = false;
  }
  if (event.name === "PermissionRequest") {
    payload["tool_name"] = "Read";
    payload["tool_input"] = {};
    payload["permission_suggestions"] = [];
  }
  return JSON.stringify(payload);
}

interface ProbeOutcome {
  timedOut: boolean;
  /** null when the process was killed rather than exiting on its own. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** The output cap was hit and the process killed: the exit code means nothing. */
  truncated: boolean;
  /** Set when the process could not be started at all. */
  spawnError?: string;
}

function describe(
  path: string,
  outcome: ProbeOutcome,
  timeoutMs: number,
): HookProtocolProblem[] {
  if (outcome.spawnError !== undefined) {
    return [
      {
        path,
        rule: "hook-protocol-crash",
        message: `cannot be invoked (${outcome.spawnError}) — every harness runs it as \`node ${path}\`; fix the file or remove it.`,
      },
    ];
  }
  if (outcome.timedOut) {
    return [
      {
        path,
        rule: "hook-protocol-timeout",
        message: `did not return within ${timeoutMs} ms on a sample payload — every harness would block on this hook at each event; make it answer, and never wait for input beyond the payload.`,
      },
    ];
  }
  const problems: HookProtocolProblem[] = [];
  const stdout = outcome.stdout.trim();
  if (stdout !== "" && !stdout.startsWith("{")) {
    problems.push({
      path,
      rule: "hook-protocol-stdout",
      message: `wrote ${JSON.stringify(firstLine(stdout))} on stdout — the protocol allows an empty stdout or a single JSON object starting with "{"; free text is read as a malformed decision. Log to stderr instead.`,
    });
  }
  // killed for flooding stdout: the code says nothing the line above did not
  if (
    !outcome.truncated &&
    (outcome.code === null || !DOCUMENTED_EXIT_CODES.has(outcome.code))
  ) {
    problems.push({
      path,
      rule: "hook-protocol-exit",
      message: `exited with code ${outcome.code ?? "null (killed)"} on a sample payload — the documented codes are 0 (continue) and 2 (block); anything else is the script failing before it decided.${stderrHint(outcome.stderr)}`,
    });
  }
  return problems;
}

function stderrHint(stderr: string): string {
  const first = firstLine(stderr.trim());
  return first === "" ? "" : ` First line of stderr: ${JSON.stringify(first)}.`;
}

function firstLine(text: string): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/**
 * One bounded invocation. The environment is inherited untouched — adding a
 * variable would make the probe run the script in conditions no harness ever
 * reproduces — and stdin is closed right after the payload, so a script waiting
 * for more input hits end-of-file instead of hanging on an interactive read.
 */
async function invoke(
  root: string,
  file: string,
  payload: string,
  timeoutMs: number,
): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [join(root, ".agents", "hooks", file)],
      { cwd: root, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let truncated = false;
    let spawnError: string | undefined;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const finish = (code: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        timedOut,
        code,
        stdout,
        stderr,
        truncated,
        ...(spawnError !== undefined ? { spawnError } : {}),
      });
    };
    const cap = (current: string, chunk: string): string => {
      if (current.length >= HOOK_PROBE_MAX_OUTPUT) {
        truncated = true;
        child.kill("SIGKILL");
        return current;
      }
      return current + chunk;
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = cap(stdout, chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = cap(stderr, chunk);
    });
    // a script that exits before reading its payload makes this write fail with
    // EPIPE: that is its right, and says nothing about the protocol
    child.stdin.on("error", () => {});
    child.stdin.end(payload);
    child.on("error", (error) => {
      spawnError = error.message;
      finish(null);
    });
    child.on("close", (code) => {
      finish(code);
    });
  });
}
