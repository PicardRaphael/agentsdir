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
  const { command } = resolveCommand(main, argv);
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

interface Resolution {
  command: CommandDef;
  /** How the command is invoked, e.g. `["add", "skill"]` — empty at the root. */
  path: string[];
  /** Tokens left for the command itself, once the subcommand path is consumed. */
  operands: string[];
}

/**
 * Walks the subcommand tree and separates the command's own operands from
 * everything else. Option *values* are not operands: read naively,
 * `add hook --name foo` offers `foo` as the event and hides that the required
 * one is missing. Which options take a value is read from the command
 * definitions, level by level, so this cannot drift from what they declare.
 */
function resolveCommand(main: CommandDef, argv: string[]): Resolution {
  let command = main;
  const path: string[] = [];
  const operands: string[] = [];
  let takesValue = valueOptions(command);
  let terminated = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (terminated) {
      operands.push(token);
      continue;
    }
    if (token === "--") {
      terminated = true;
      continue;
    }
    if (token.startsWith("-")) {
      const name = token.replace(/^--?/, "").split("=")[0] ?? "";
      if (takesValue.has(name) && !token.includes("=")) {
        index += 1;
      }
      continue;
    }
    const child = subCommand(command, token);
    if (child === undefined || operands.length > 0) {
      operands.push(token);
      continue;
    }
    command = child;
    path.push(token);
    takesValue = valueOptions(command);
  }
  return { command, path, operands };
}

function subCommand(command: CommandDef, name: string): CommandDef | undefined {
  const children = command.subCommands;
  if (children === undefined || typeof children === "function") {
    return undefined;
  }
  return (children as Record<string, CommandDef | undefined>)[name];
}

/**
 * Long names of the options that consume the next token. Aliases are not read:
 * no command here declares one, and inventing support for what nothing
 * exercises is how an untested branch gets it wrong later.
 */
function valueOptions(command: CommandDef): Set<string> {
  const names = new Set<string>();
  for (const [name, definition] of Object.entries(asArgs(command))) {
    const type = (definition as { type?: string }).type;
    if (type === "string" || type === "enum") {
      names.add(name);
    }
  }
  return names;
}

/**
 * Rejects a missing required positional before citty gets it. Left to citty,
 * `agentsdir add skill` prints the help and exits 1 — the drift code. A CI
 * script reading that cannot tell "the repository moved" from "the command was
 * called wrong", which is exactly what the two codes are for
 * (`docs/commandes.md`).
 */
export function missingArgument(
  main: CommandDef,
  argv: string[],
): string | undefined {
  if (argv.some((token) => token === "--help" || token === "-h")) {
    return undefined;
  }
  const { command, path, operands } = resolveCommand(main, argv);
  const required = requiredPositionals(command);
  const missing = required[operands.length];
  if (missing === undefined) {
    return undefined;
  }
  const invocation = ["agentsdir", ...path].join(" ");
  const usage = required.map((name) => `<${name}>`).join(" ");
  return `Missing required argument <${missing}> for \`${invocation}\`. Usage: ${invocation} ${usage} [options].`;
}

/** Positional names a command cannot run without, in declaration order. */
function requiredPositionals(command: CommandDef): string[] {
  const names: string[] = [];
  for (const [name, definition] of Object.entries(asArgs(command))) {
    const argument = definition as {
      type?: string;
      required?: boolean;
      default?: unknown;
    };
    if (
      argument.type === "positional" &&
      argument.required !== false &&
      argument.default === undefined
    ) {
      names.push(name);
    }
  }
  return names;
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
