import type { ArgsDef, CommandDef } from "citty";

/** Subcommand names of each group, in the order the help lists them. */
const COMMAND_TREE: Record<string, string[]> = {
  "": ["init", "add", "pack", "sync", "check", "update", "doctor"],
  add: ["skill", "rule", "agent", "hook"],
  pack: ["add", "remove"],
};

/** Accepted everywhere, declared by citty itself rather than by a command. */
const BUILTIN_OPTIONS = new Set(["help", "h", "version", "v"]);

/**
 * Rejects an unknown command before citty gets it. Left to citty, a typo prints
 * the help and exits 1 — the drift code, which a CI script would read as
 * "drift detected" instead of "you mistyped". Usage errors are exit 2 here
 * (`docs/commandes.md`), and the message names what was not understood.
 */
export function unknownCommand(argv: string[]): string | undefined {
  const positionals = argv.filter((argument) => !argument.startsWith("-"));
  const first = positionals[0];
  if (first === undefined) {
    return undefined;
  }
  const top = COMMAND_TREE[""] ?? [];
  if (!top.includes(first)) {
    return `Unknown command "${first}" (available: ${top.join(", ")}).`;
  }
  const children = COMMAND_TREE[first];
  const second = positionals[1];
  if (children === undefined || second === undefined) {
    return undefined;
  }
  return children.includes(second)
    ? undefined
    : `Unknown command "${first} ${second}" (available: ${children
        .map((child) => `${first} ${child}`)
        .join(", ")}).`;
}

/**
 * Rejects an option no command declares. citty silently ignores those, so a
 * typo on `--dry-run` ran the real thing: `agentsdir init --dryrun` wrote the
 * whole architecture and exited 0, while the user believed they were
 * simulating. The declared options are read from the command definitions, so
 * this can never drift from what the commands actually accept.
 */
export function unknownOption(
  main: CommandDef,
  argv: string[],
): string | undefined {
  const command = resolveCommand(main, argv);
  const declared = new Set(Object.keys(asArgs(command)));
  for (const token of optionNames(argv)) {
    if (declared.has(token) || BUILTIN_OPTIONS.has(token)) {
      continue;
    }
    const known = [...declared].sort();
    const suffix =
      known.length > 0
        ? ` Known options here: ${known.map((name) => `--${name}`).join(", ")}.`
        : "";
    return `Unknown option "--${token}".${suffix}`;
  }
  return undefined;
}

/** Option names as written, without their values, `--no-` prefix or `=value`. */
function optionNames(argv: string[]): string[] {
  const names: string[] = [];
  for (const argument of argv) {
    if (argument === "--") {
      break;
    }
    if (!argument.startsWith("-")) {
      continue;
    }
    const withoutDashes = argument.replace(/^--?/, "");
    const name = (withoutDashes.split("=")[0] ?? "").replace(/^no-/, "");
    if (name !== "") {
      names.push(name);
    }
  }
  return names;
}

/** Walks the subcommand tree as far as the positionals actually go. */
function resolveCommand(main: CommandDef, argv: string[]): CommandDef {
  let command = main;
  for (const positional of argv.filter(
    (argument) => !argument.startsWith("-"),
  )) {
    const children = command.subCommands;
    if (children === undefined || typeof children === "function") {
      break;
    }
    const child = (children as Record<string, CommandDef | undefined>)[
      positional
    ];
    if (child === undefined) {
      break;
    }
    command = child;
  }
  return command;
}

function asArgs(command: CommandDef): ArgsDef {
  const args = command.args;
  // citty allows a resolvable (function or promise); every command here
  // declares a plain object, and a resolvable is simply not validated
  return args !== undefined &&
    typeof args === "object" &&
    !(args instanceof Promise)
    ? args
    : {};
}
