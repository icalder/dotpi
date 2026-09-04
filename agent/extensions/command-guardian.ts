import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

/**
 * Confirms destructive commands, except disposable scratch paths.
 *
 * Configuration (environment, no edit of this file needed):
 *   PI_GUARDIAN_SAFE_DELETE_PATHS="/tmp/:/var/tmp/"  absolute scratch prefixes, colon separated
 *   PI_GUARDIAN_ALLOW_RECURSIVE=1                    stop prompting for recursive removal inside them
 *
 * Limits of static text analysis, accepted by design:
 *   - symlinks are not resolved: a scratch path can point somewhere else
 *   - globs are matched as literal text, the shell expands them after this check
 *   - deletion means rm, unlink, shred and `find -delete`; `dd`, `truncate` and
 *     friends overwrite content instead of removing paths
 */

/* ------------------------------------------------------------------ policy */

/** Scratch prefixes used when the environment names none. */
const DEFAULT_SAFE_DELETE_PREFIXES: readonly string[] = ["/tmp/", "/var/tmp/"];

/** Colon separated list of absolute scratch prefixes. */
const SAFE_PATHS_ENV = "PI_GUARDIAN_SAFE_DELETE_PATHS";

/** "1" or "true" allows recursive removal inside a scratch prefix without a prompt. */
const ALLOW_RECURSIVE_ENV = "PI_GUARDIAN_ALLOW_RECURSIVE";

/** Recursive removal amplifies a wrong target, so it prompts unless opted out. */
const DEFAULT_ALLOW_RECURSIVE = false;

/** Wrappers that do not change which command runs. */
const COMMAND_WRAPPERS: ReadonlySet<string> = new Set([
  "sudo",
  "doas",
  "env",
  "time",
  "command",
  "nice",
]);

/**
 * Shell syntax whose result cannot be known from the command text alone.
 * A backslash is kept on purpose: a name written with escapes is rare enough
 * that prompting is cheaper than reasoning about it.
 */
const AMBIGUOUS_SYNTAX = /[$`\\<>{}]/;

/** `..` as a whole path segment, unlike the `..` inside `notes..old.txt`. */
const TRAVERSAL_SEGMENT = /(?:^|\/)\.\.(?:$|\/)/;

/** A rule answers one question: must this statement be confirmed by a human? */
interface CommandRule {
  readonly name: string;
  requiresConfirmation(statement: string): boolean;
}

/** Lexical containment in a scratch directory: no escape, no traversal. */
class SafeDeletionZone {
  private readonly prefixes: readonly string[];

  constructor(prefixes: readonly string[]) {
    this.prefixes = prefixes;
  }

  contains(path: string): boolean {
    if (TRAVERSAL_SEGMENT.test(path) || AMBIGUOUS_SYNTAX.test(path)) return false;
    return this.prefixes.some(
      (prefix) => path.length > prefix.length && path.startsWith(prefix),
    );
  }
}

/* ----------------------------------------------------------------- parsing */

/**
 * Splits a command line into statements at unquoted ; | & newline.
 * Separators inside quotes are literal text and are left alone.
 */
function splitStatements(command: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "\\" && i + 1 < command.length) {
      current += char + command[++i];
      continue;
    }
    if (char === ";" || char === "|" || char === "&" || char === "\n") {
      statements.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  statements.push(current);

  return statements.map((statement) => statement.trim()).filter(Boolean);
}

/** Whitespace split that keeps quoted words intact and drops their quotes. */
function tokenize(statement: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: string | null = null;
  let started = false;

  for (let i = 0; i < statement.length; i++) {
    const char = statement[i];
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === "\\" && i + 1 < statement.length) {
      // Backslash-newline is a line continuation: the shell deletes the pair
      // and keeps the word going, it does not embed a newline in the argument.
      if (statement[i + 1] !== "\n") token += statement[++i];
      else i++;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) tokens.push(token);
      token = "";
      started = false;
      continue;
    }
    token += char;
    started = true;
  }
  if (started) tokens.push(token);

  return tokens;
}

interface CommandPosition {
  program: string;
  args: string[];
}

/**
 * The program and arguments the shell would run, after wrapper stripping.
 * Null when the command position is not a plain program: an expansion, a
 * wrapper with assignments (`env VAR=x rm`), or a missing program.
 */
function commandPosition(tokens: string[]): CommandPosition | null {
  let index = 0;
  while (index < tokens.length && COMMAND_WRAPPERS.has(tokens[index])) {
    if (tokens[index + 1]?.includes("=")) return null;
    index++;
  }
  const program = tokens[index];
  if (!program || AMBIGUOUS_SYNTAX.test(program)) return null;

  return { program, args: tokens.slice(index + 1) };
}

function runsProgram(position: CommandPosition, program: string): boolean {
  return position.program === program || position.program.endsWith(`/${program}`);
}

/** The argument list of a deleter, split into flags and targets. */
interface DeletionArguments {
  flags: string[];
  targets: string[];
}

/**
 * Reads `<flags> <targets>` after a deleter has been identified. Null when the
 * arguments cannot be read, for example the bare "-" that stands for stdin.
 * Flags listed in `valueFlags` swallow the argument that follows them, so
 * `shred -n 1 /tmp/x` keeps `/tmp/x` as its only target.
 */
function parseDeletionArguments(
  args: readonly string[],
  valueFlags: readonly string[],
): DeletionArguments | null {
  const flags: string[] = [];
  const targets: string[] = [];
  let optionsEndSeen = false;
  let valuePending = false;

  for (const token of args) {
    if (valuePending) {
      valuePending = false;
      continue;
    }
    if (!optionsEndSeen && token === "--") {
      optionsEndSeen = true;
      continue;
    }
    if (!optionsEndSeen && token.startsWith("--")) {
      const name = token.slice(2).split("=")[0];
      flags.push(name);
      valuePending = !token.includes("=") && valueFlags.includes(name);
      continue;
    }
    if (!optionsEndSeen && token.startsWith("-") && token.length > 1) {
      const letters = token.slice(1).split("");
      flags.push(...letters);
      valuePending = letters.length === 1 && valueFlags.includes(letters[0]);
      continue;
    }
    if (token.startsWith("-")) return null;
    targets.push(token);
  }

  return { flags, targets };
}

function hasAmbiguousFlag(flags: readonly string[]): boolean {
  return flags.some((flag) => AMBIGUOUS_SYNTAX.test(flag));
}

/* ------------------------------------------------------------------- rules */

/**
 * How one deletion program spells its switches: `recursiveFlags` amplify the
 * removal, `valueFlags` take the argument that follows them.
 */
interface DeleterSpec {
  readonly name: string;
  readonly program: string;
  readonly recursiveFlags: readonly string[];
  readonly valueFlags: readonly string[];
}

const RM_DELETER: DeleterSpec = {
  name: "rm",
  program: "rm",
  recursiveFlags: ["r", "R", "recursive"],
  valueFlags: [],
};

/** `unlink` takes one file, `shred` destroys the named files: neither descends. */
const UNLINK_DELETER: DeleterSpec = {
  name: "unlink",
  program: "unlink",
  recursiveFlags: [],
  valueFlags: [],
};
const SHRED_DELETER: DeleterSpec = {
  name: "shred",
  program: "shred",
  recursiveFlags: [],
  valueFlags: ["n", "s", "size", "random-source"],
};

function isRecursive(flags: readonly string[], spec: DeleterSpec): boolean {
  return spec.recursiveFlags.some((recursive) => flags.includes(recursive));
}

/**
 * Removal of every target inside a scratch prefix is routine cleanup: no
 * prompt. Anything this rule cannot read stays noisy.
 */
class DeletionRule implements CommandRule {
  readonly name: string;

  private readonly spec: DeleterSpec;
  private readonly safeZone: SafeDeletionZone;
  private readonly allowRecursive: boolean;
  private readonly mentionPattern: RegExp;

  constructor(spec: DeleterSpec, safeZone: SafeDeletionZone, allowRecursive: boolean) {
    this.spec = spec;
    this.safeZone = safeZone;
    this.allowRecursive = allowRecursive;
    this.name = spec.name;
    // `(?<!-)` keeps the filter from firing on flags like `--rm` or `--shred` that happen to spell a deleter name: the program word must stand on its own, not be the tail of `--<word>`.
    this.mentionPattern = new RegExp(`(?<!-)\\b${spec.program}\\b`);
  }

  requiresConfirmation(statement: string): boolean {
    if (!this.mentionPattern.test(statement)) return false;

    const position = commandPosition(tokenize(statement));
    if (!position) return true; // wrapper or program we cannot read
    if (!runsProgram(position, this.spec.program)) return true; // rm inside bash -c "..."

    const args = parseDeletionArguments(position.args, this.spec.valueFlags);
    if (!args || args.targets.length === 0) return true;
    if (hasAmbiguousFlag(args.flags)) return true; // rm -$FLAGS /tmp/x
    if (!this.allowRecursive && isRecursive(args.flags, this.spec)) return true;

    return !args.targets.every((target) => this.safeZone.contains(target));
  }
}

/** `-delete` removes whole trees, `-exec` runs an arbitrary program. */
const FIND_DELETE_ACTION = "-delete";
/**
 * `-delete` spelled anywhere in a statement, inside quotes or not. The
 * lookbehind keeps `--delete` and `x-delete` from matching.
 */
const FIND_DELETE_MENTION = /(?<![-\w])-delete\b/;
const FIND_EXPRESSION_START = /^[-(!]/;
const FIND_EXEC_ACTIONS: ReadonlySet<string> = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
]);
const FIND_SYMLINK_OPTIONS: ReadonlySet<string> = new Set(["-H", "-L", "-follow"]);

interface FindArguments {
  startPaths: string[];
  expression: string[];
}

/**
 * Splits find arguments the way find does: start paths first, then the
 * expression, which starts at the first option or operator.
 */
function parseFindArguments(args: readonly string[]): FindArguments {
  const startPaths: string[] = [];
  const expression: string[] = [];

  for (const token of args) {
    if (expression.length === 0 && !FIND_EXPRESSION_START.test(token)) startPaths.push(token);
    else expression.push(token);
  }

  return { startPaths, expression };
}

/** `find <paths> -delete` deletes every path below the start paths. */
class FindDeleteRule implements CommandRule {
  readonly name = "find -delete";

  private readonly safeZone: SafeDeletionZone;
  private readonly allowRecursive: boolean;

  constructor(safeZone: SafeDeletionZone, allowRecursive: boolean) {
    this.safeZone = safeZone;
    this.allowRecursive = allowRecursive;
  }

  requiresConfirmation(statement: string): boolean {
    if (!/\bfind\b/.test(statement)) return false;

    const position = commandPosition(tokenize(statement));
    if (!position) return true;
    if (!runsProgram(position, "find")) {
      // find is only mentioned, e.g. `grep ... $(find . | head)` (the
      // `$( ... )` substitution splits into its own fragment) or
      // `bash -c 'find / -delete'`. A mention is not a deletion unless
      // `-delete` is actually spelled in the statement.
      return FIND_DELETE_MENTION.test(statement);
    }

    const { startPaths, expression } = parseFindArguments(position.args);
    if (!expression.includes(FIND_DELETE_ACTION)) return false;
    if (expression.some((token) => FIND_EXEC_ACTIONS.has(token))) return true;
    if (expression.some((token) => FIND_SYMLINK_OPTIONS.has(token))) return true;
    if (!this.allowRecursive) return true;
    if (startPaths.length === 0) return true; // find defaults to "."

    return !startPaths.every((startPath) => this.safeZone.contains(startPath));
  }
}

/** History writing commands are always confirmed. */
class GitWriteRule implements CommandRule {
  readonly name = "git";

  requiresConfirmation(statement: string): boolean {
    return /\bgit\s+commit\b/.test(statement) || /\bgit\s+push\b/.test(statement);
  }
}

/* ------------------------------------------------------------------ guard */

class CommandGuard {
  private readonly rules: readonly CommandRule[];

  constructor(rules: readonly CommandRule[]) {
    this.rules = rules;
  }

  /** First rule that demands confirmation wins; unknown shapes stay noisy. */
  offender(command: string): CommandRule | null {
    const statements = splitStatements(command);
    for (const rule of this.rules) {
      if (statements.some((statement) => rule.requiresConfirmation(statement))) {
        return rule;
      }
    }
    return null;
  }
}

/* ----------------------------------------------------------------- config */

function environmentValue(name: string): string | undefined {
  return typeof process === "undefined" ? undefined : process.env[name];
}

/**
 * Absolute scratch prefixes from the environment, defaults when the value is
 * missing or unusable. The filesystem root is never a scratch prefix, and an
 * empty entry never becomes one either.
 */
function safeDeletePrefixes(): readonly string[] {
  const configured = environmentValue(SAFE_PATHS_ENV);
  if (!configured) return DEFAULT_SAFE_DELETE_PREFIXES;

  const prefixes = configured.split(":").map(normalizePrefix).filter(isPrefix);
  return prefixes.length > 0 ? prefixes : DEFAULT_SAFE_DELETE_PREFIXES;
}

function normalizePrefix(entry: string): string | null {
  const trimmed = entry.trim();
  if (!trimmed.startsWith("/") || trimmed === "/") return null;
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function isPrefix(prefix: string | null): prefix is string {
  return prefix !== null;
}

function allowRecursiveInSafePaths(): boolean {
  const configured = environmentValue(ALLOW_RECURSIVE_ENV);
  if (configured === undefined) return DEFAULT_ALLOW_RECURSIVE;

  const value = configured.trim().toLowerCase();
  return value === "1" || value === "true";
}

export interface CommandGuardOptions {
  readonly safeDeletePrefixes?: readonly string[];
  readonly allowRecursiveInSafePaths?: boolean;
}

/** The guard used by the extension, and by tests that need other settings. */
export function createCommandGuard(options: CommandGuardOptions = {}): CommandGuard {
  const safeZone = new SafeDeletionZone(options.safeDeletePrefixes ?? safeDeletePrefixes());
  const allowRecursive =
    options.allowRecursiveInSafePaths ?? allowRecursiveInSafePaths();

  return new CommandGuard([
    new DeletionRule(RM_DELETER, safeZone, allowRecursive),
    new DeletionRule(UNLINK_DELETER, safeZone, allowRecursive),
    new DeletionRule(SHRED_DELETER, safeZone, allowRecursive),
    new FindDeleteRule(safeZone, allowRecursive),
    new GitWriteRule(),
  ]);
}

const guard = createCommandGuard();

/* --------------------------------------------------------------- extension */

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    const command = event.input.command;
    const offender = guard.offender(command);
    if (!offender) return;

    if (!ctx.hasUI) {
      // Allow by default in non-interactive mode (-p, JSON, RPC).
      // Blocking here would silently break CI/CD pipelines and scripted
      // workflows where the agent is expected to run commands autonomously.
      // Users who want hard blocking in headless mode should not enable
      // this extension in those environments.
      return;
    }

    const approved = await ctx.ui.confirm(
      `Dangerous Command Detected! (${offender.name})`,
      `Do you want to proceed with: \n\`${command}\`?`,
    );

    if (!approved) {
      ctx.ui.notify("Command blocked by Command Guardian extension", "warning");
      return { block: true, reason: "Command blocked by Command Guardian extension" };
    }
  });
}

/** Exported for manual checks: does this command need a human? */
export function requiresConfirmation(command: string): boolean {
  return guard.offender(command) !== null;
}

export {
  CommandGuard,
  DeletionRule,
  FindDeleteRule,
  GitWriteRule,
  SafeDeletionZone,
  allowRecursiveInSafePaths,
  safeDeletePrefixes,
};
