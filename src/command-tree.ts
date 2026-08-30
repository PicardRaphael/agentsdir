/** Subcommand names of each group, in the order the help lists them. */
const COMMAND_TREE: Record<string, string[]> = {
  "": ["init", "add", "pack", "sync", "check", "doctor"],
  add: ["skill", "rule", "agent", "hook"],
  pack: ["add", "remove"],
};

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
