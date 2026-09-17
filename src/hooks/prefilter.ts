/**
 * Deterministic prefilters: decide in code whether Jev is called at all.
 *
 * Three jobs, in order of confidence:
 *  1. Recognize the small set of commands that are unambiguously catastrophic
 *     and escalate them without asking a model. A regex is more reliable than
 *     a classifier for `rm -rf ~`.
 *  2. Recognize work that is plainly read-only, and stay out of the way. This
 *     is what keeps the hook from costing a call and 300 ms on every `ls`.
 *  3. Send everything else to judgment. "Everything else" includes anything
 *     the tokenizer did not fully understand: an unknown construct is a reason
 *     to look closer, never a reason to skip.
 *
 * Pure functions only. No I/O, no clock, no model.
 */

import { isAbsolute, resolve, sep } from "node:path";

export type Prefilter =
  /** Plainly read-only: no Jev call, no output. */
  | { kind: "skip"; reason: string }
  /** Send to Jev. */
  | { kind: "judge"; reason: string }
  /** Code is sure enough to escalate on its own. */
  | { kind: "escalate"; reason: string; pattern: string };

// --------------------------------------------------------------- bash scanner

export interface BashFeatures {
  /** `>`, `>>`, `&>`, `>|`, `>(`. Input redirects are read-only and ignored. */
  redirect: boolean;
  /** `$(...)`, backticks, `<(...)`: we cannot see what actually runs. */
  substitution: boolean;
  /** `$VAR`, `${VAR}`: we cannot see what the word expands to. */
  expansion: boolean;
  /** Subshells and brace groups: structure this scanner does not model. */
  grouping: boolean;
  /** `<<` / `<<<`: the body is inline content this scanner does not model. */
  heredoc: boolean;
  /** A quote never closed. */
  unbalanced: boolean;
}

export interface BashScan {
  /** One token list per pipeline/`&&`/`;` segment, empty ones dropped. */
  segments: string[][];
  features: BashFeatures;
}

const SEPARATORS = new Set([";", "\n", "|", "&"]);

/**
 * Tokenize a shell command far enough to reason about it, and flag every
 * construct that makes the reasoning unsound.
 *
 * This is not a shell parser and does not try to be. It is quote-aware,
 * separator-aware, and loudly pessimistic about anything else.
 */
export function scanBash(command: string): BashScan {
  const features: BashFeatures = {
    redirect: false,
    substitution: false,
    expansion: false,
    grouping: false,
    heredoc: false,
    unbalanced: false,
  };
  const segments: string[][] = [];
  let tokens: string[] = [];
  let token = "";
  let started = false;

  const endToken = (): void => {
    if (started) {
      tokens.push(token);
      token = "";
      started = false;
    }
  };
  const endSegment = (): void => {
    endToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };
  const push = (text: string): void => {
    token += text;
    started = true;
  };

  let index = 0;
  while (index < command.length) {
    const char = command[index] as string;

    if (char === "'") {
      const close = command.indexOf("'", index + 1);
      if (close === -1) {
        features.unbalanced = true;
        push(command.slice(index + 1));
        index = command.length;
        continue;
      }
      push(command.slice(index + 1, close));
      index = close + 1;
      continue;
    }

    if (char === '"') {
      index += 1;
      let closed = false;
      while (index < command.length) {
        const inner = command[index] as string;
        if (inner === "\\") {
          push(command[index + 1] ?? "");
          index += 2;
          continue;
        }
        if (inner === '"') {
          closed = true;
          index += 1;
          break;
        }
        if (inner === "`") {
          features.substitution = true;
          index += 1;
          continue;
        }
        if (inner === "$") {
          if (command[index + 1] === "(") features.substitution = true;
          else features.expansion = true;
          push(inner);
          index += 1;
          continue;
        }
        push(inner);
        index += 1;
      }
      if (!closed) features.unbalanced = true;
      started = true;
      continue;
    }

    if (char === "\\") {
      push(command[index + 1] ?? "");
      index += 2;
      continue;
    }

    if (char === "`") {
      features.substitution = true;
      index += 1;
      continue;
    }

    if (char === "$") {
      if (command[index + 1] === "(") {
        features.substitution = true;
        index += 2;
        continue;
      }
      features.expansion = true;
      push(char);
      index += 1;
      continue;
    }

    if (char === ">") {
      features.redirect = true;
      endToken();
      index += 1;
      while (command[index] === ">" || command[index] === "|" || command[index] === "(") {
        if (command[index] === "(") features.substitution = true;
        index += 1;
      }
      continue;
    }

    if (char === "<") {
      if (command[index + 1] === "(") features.substitution = true;
      if (command[index + 1] === "<") features.heredoc = true;
      endToken();
      index += 1;
      while (command[index] === "<") index += 1;
      continue;
    }

    if (char === "&") {
      if (command[index + 1] === ">") {
        features.redirect = true;
        index += 2;
        continue;
      }
      endSegment();
      index += command[index + 1] === "&" ? 2 : 1;
      continue;
    }

    if (SEPARATORS.has(char)) {
      endSegment();
      index += char === "|" && command[index + 1] === "|" ? 2 : 1;
      continue;
    }

    if (char === "(" || char === ")" || char === "{" || char === "}") {
      // `(subshell)`, `{ group; }`, and function definitions are structure this
      // scanner does not model. Flag and move on; the caller will judge.
      features.grouping = true;
      endToken();
      index += 1;
      continue;
    }

    if (/\s/.test(char)) {
      endToken();
      index += 1;
      continue;
    }

    push(char);
    index += 1;
  }

  endSegment();
  return { segments, features };
}

// ------------------------------------------------------------- hard patterns

/** Shell-agnostic flattening: quotes removed, one space between tokens. */
function flatten(scan: BashScan): string {
  return scan.segments.map((tokens) => tokens.join(" ")).join(" ; ");
}

function isRoot(target: string): boolean {
  return /^\/+\*?$/.test(target);
}

function escapesUp(target: string): boolean {
  return target.split("/").includes("..");
}

function isHomeish(target: string): boolean {
  return /^(~|\$HOME|\$\{HOME\})(\/\*?)?$/.test(target);
}

/** A single catastrophic-command check. */
interface HardPattern {
  name: string;
  reason: string;
  matches: (tokens: string[], flat: string) => boolean;
}

const HARD_PATTERNS: HardPattern[] = [
  {
    name: "rm-rf-wide",
    reason: "recursive delete of a home, root, or parent-escaping path",
    matches: (tokens) => {
      const command = commandOf(tokens);
      if (command !== "rm") return false;
      const operands: string[] = [];
      let recursive = false;
      for (const token of tokens.slice(indexOfCommand(tokens) + 1)) {
        if (token.startsWith("--")) {
          if (token === "--recursive") recursive = true;
          continue;
        }
        if (token.startsWith("-") && token.length > 1) {
          if (/[rR]/.test(token.slice(1))) recursive = true;
          continue;
        }
        operands.push(token);
      }
      if (!recursive) return false;
      return operands.some((target) => isRoot(target) || isHomeish(target) || escapesUp(target));
    },
  },
  {
    name: "git-force-push-main",
    reason: "force push to a main branch",
    matches: (tokens) => {
      if (commandOf(tokens) !== "git" || !tokens.includes("push")) return false;
      const forced = tokens.some((t) => t === "--force" || t === "-f" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(t));
      if (!forced) return false;
      return tokens.some((t) => /(^|[:/])(main|master)$/.test(t));
    },
  },
  {
    name: "git-reset-hard",
    reason: "git reset --hard discards uncommitted work",
    matches: (tokens) =>
      commandOf(tokens) === "git" && tokens.includes("reset") && tokens.some((t) => t === "--hard"),
  },
  {
    name: "sql-drop",
    reason: "dropping a SQL table or database",
    matches: (_tokens, flat) => /\bdrop\s+(table|database|schema)\b/i.test(flat),
  },
  {
    name: "mkfs",
    reason: "formatting a filesystem",
    matches: (tokens) => /^mkfs(\.|$)/.test(commandOf(tokens)),
  },
  {
    name: "dd-to-device",
    reason: "dd writing straight to a device",
    matches: (tokens) => commandOf(tokens) === "dd" && tokens.some((t) => /^of=\/dev\//.test(t)),
  },
  {
    name: "chmod-777",
    reason: "recursive world-writable permissions",
    matches: (tokens) => {
      if (commandOf(tokens) !== "chmod") return false;
      const recursive = tokens.some((t) => t === "-R" || t === "-r" || t === "--recursive");
      return recursive && tokens.some((t) => /^0?777$/.test(t) || /^a\+?rwx$/.test(t) || /^a=rwx$/.test(t));
    },
  },
  {
    name: "fork-bomb",
    reason: "fork bomb",
    matches: (_tokens, flat) => /:\s*\(\s*\)\s*\{/.test(flat),
  },
];

/**
 * Patterns matched on the raw string, for shapes tokenization destroys. Kept
 * to the two that cannot plausibly appear in innocent text.
 */
const RAW_HARD_PATTERNS: [string, string, RegExp][] = [
  ["fork-bomb", "fork bomb", /:\s*\(\s*\)\s*\{\s*:?\s*\|?/],
  ["dd-to-device", "dd writing straight to a device", /\bdd\b[^;|&]*\bof=["']?\/dev\//],
];

// ------------------------------------------------------------- the allowlist

/**
 * Environment assignments that are safe to see in front of a command.
 *
 * The allowlist exists because `PATH=/evil ls` and `LD_PRELOAD=x ls` run
 * something other than `ls`, and `GIT_SSH_COMMAND=x git log` runs `x`. An
 * assignment is a way to replace the program, so only names that cannot
 * change what executes are permitted.
 */
const BENIGN_ASSIGNMENTS =
  /^(CI|NODE_ENV|FORCE_COLOR|NO_COLOR|CLICOLOR|CLICOLOR_FORCE|DEBUG|TZ|LANG|LANGUAGE|LC_[A-Z_]+|RUST_BACKTRACE|TERM|COLUMNS|LINES)$/;

/**
 * Directories whose contents are the system's own tools. A command spelled
 * with a path is only the command it looks like if it comes from one of these:
 * `/tmp/evil/ls` and `./ls` are not `ls`.
 */
const SYSTEM_BINS = new Set(["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", "/sbin", "/usr/sbin"]);

/** Leading `FOO=bar` assignments are not the command. */
function indexOfCommand(tokens: string[]): number {
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] as string)) index += 1;
  return index;
}

/** The names of the leading assignments, in order. */
function assignmentNames(tokens: string[]): string[] {
  return tokens.slice(0, indexOfCommand(tokens)).map((token) => token.slice(0, token.indexOf("=")));
}

/** `true` when the command word names a path outside the system bin dirs. */
function isForeignPath(tokens: string[]): boolean {
  const raw = tokens[indexOfCommand(tokens)] ?? "";
  if (!raw.includes("/")) return false;
  const slash = raw.lastIndexOf("/");
  const dir = raw.slice(0, slash) === "" ? "/" : raw.slice(0, slash);
  return !SYSTEM_BINS.has(dir);
}

function commandOf(tokens: string[]): string {
  const raw = tokens[indexOfCommand(tokens)] ?? "";
  // `/usr/bin/git` is git. `/tmp/evil/git` is not, but naming it `git` here is
  // still right: `isForeignPath` rejects it, and a hard pattern should match on
  // the name whatever directory it was spelled with.
  const base = raw.split("/").pop() ?? raw;
  return base.toLowerCase();
}

function argsOf(tokens: string[]): string[] {
  return tokens.slice(indexOfCommand(tokens) + 1);
}

/**
 * Long options that hand a read-only-looking command the ability to execute
 * something else or write a file. None of them appears benignly anywhere on
 * the allowlist, so they are rejected across the board rather than per command:
 * `git -c core.pager=…`, `rg --pre`, `ag --pager`, `sort --output`,
 * `git log --ext-diff` and friends are all the same mistake.
 */
const EXEC_OPTIONS = new Set([
  "--pager",
  "--pre",
  "--pre-glob",
  "--hostname-bin",
  "--exec",
  "--execdir",
  "--textconv",
  "--ext-diff",
  "--config-env",
  "--exec-path",
  "--in-place",
  "--inplace",
  "--set",
  "--output",
  "--upload-pack",
  "--receive-pack",
  "--filter-process",
]);

/** The first exec-enabling long option in `args`, if any. */
function execOption(args: string[]): string | undefined {
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (EXEC_OPTIONS.has(name)) return name;
  }
  return undefined;
}

/**
 * The first argument that names something secret, if any.
 *
 * `cat` is read-only and `cat ~/.ssh/id_rsa` is an exfiltration step. The
 * predicate is the same one the file-tool prefilter uses, so the two agree by
 * construction; it matches on basenames and path segments, so it needs no
 * expansion of `~` and no `cwd` (a `$HOME`-spelled path sets the expansion
 * flag and is judged before this runs).
 */
function secretArgument(args: string[]): string | undefined {
  for (const arg of args) {
    if (isSensitivePath(arg)) return arg;
    if (arg.includes("=")) {
      const value = arg.slice(arg.indexOf("=") + 1);
      if (value !== "" && isSensitivePath(value)) return value;
    }
  }
  return undefined;
}

/** Skip the values of flags that take one, so positionals can be counted. */
function positionals(args: string[], valueFlags: Set<string>): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (valueFlags.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") continue;
    out.push(arg);
  }
  return out;
}

function noFlag(args: string[], ...flags: string[]): boolean {
  return !args.some((arg) => flags.includes(arg));
}

/** First argument that is not a flag. */
function firstWord(args: string[]): string {
  return args.find((arg) => !arg.startsWith("-")) ?? "";
}

const GIT_READ_ONLY = new Set([
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "rev-parse",
  "rev-list",
  "describe",
  "blame",
  "shortlog",
  "whatchanged",
  "grep",
  "ls-files",
  "ls-tree",
  "ls-remote",
  "cat-file",
  "for-each-ref",
  "symbolic-ref",
  "name-rev",
  "merge-base",
  "count-objects",
  "diff-tree",
  "show-ref",
  "var",
  "version",
]);

const SAFE_SCRIPT = /^(test|tests|check|checks|lint|format|fmt|typecheck|type-check|types|build|coverage|unit|e2e|spec|smoke|verify|audit)([:_-][\w.-]+)*$/;

const RUNNER_SUBCOMMANDS = new Set(["test", "run", "lint", "build", "ls", "list", "why", "outdated", "view", "info"]);

/**
 * Commands whose every invocation is read-only, given that redirects,
 * substitutions and expansions are rejected globally before we get here.
 */
const ALWAYS_READ_ONLY = new Set([
  "ls",
  "ll",
  "cat",
  "bat",
  "head",
  "tail",
  "wc",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "ack",
  "pwd",
  "echo",
  "printf",
  "which",
  "whereis",
  "stat",
  "du",
  "df",
  "ps",
  "pgrep",
  "uname",
  "whoami",
  "id",
  "uptime",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "cut",
  "tr",
  "column",
  "nl",
  "diff",
  "cmp",
  "jq",
  "md5sum",
  "shasum",
  "sha256sum",
  "cksum",
  "true",
  "false",
  "sleep",
  "seq",
  "vitest",
  "jest",
  "mocha",
  "pytest",
  "mypy",
  "tflint",
]);

/** Commands that are read-only only in some shapes. */
const CONDITIONAL: Record<string, (args: string[]) => boolean> = {
  // `find -delete`/`-exec` runs arbitrary work; everything else lists.
  find: (args) => noFlag(args, "-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls", "-fprint", "-fprintf"),
  fd: (args) => noFlag(args, "-x", "--exec", "-X", "--exec-batch"),
  /**
   * `sed` is an editor. `-i` rewrites the file, and the `w` command writes one
   * from inside the script — `sed -e 'w /etc/x' f` and `sed 's/a/b/w out' f`
   * both write, with no flag that says so. Scripts are not parsed here, so the
   * only shape that skips is the one that provably cannot write: `-n` plus a
   * single line-range print.
   */
  sed: (args) => {
    const flags = args.filter((arg) => arg.startsWith("-") && arg !== "-");
    const scripts = args.filter((arg) => !arg.startsWith("-") || arg === "-");
    if (!flags.includes("-n")) return false;
    if (!flags.every((flag) => ["-n", "-E", "-r"].includes(flag))) return false;
    return scripts.length >= 1 && /^\d+(,\d+)?p$/.test(scripts[0] as string);
  },
  /** `command ls` runs ls; only the `-v`/`-V` lookup forms are read-only. */
  command: (args) => {
    const flags = args.filter((arg) => arg.startsWith("-") && arg !== "-");
    return flags.length > 0 && flags.every((flag) => flag === "-v" || flag === "-V");
  },
  /** `sort -o` writes its output to a file. */
  sort: (args) => noFlag(args, "-o", "--output") && !args.some((arg) => arg.startsWith("--output=")),
  /** `uniq [input [output]]`: a second operand is a file it overwrites. */
  uniq: (args) => positionals(args, new Set(["-f", "-s", "-w", "--skip-fields", "--skip-chars", "--check-chars"])).length <= 1,
  /** `tree -o` writes its listing to a file. */
  tree: (args) => noFlag(args, "-o", "--output") && !args.some((arg) => arg.startsWith("--output=")),
  /** `yq -i` edits in place. */
  yq: (args) => noFlag(args, "-i", "--inplace", "--in-place"),
  /** `date -s` sets the system clock; a non-format operand does the same. */
  date: (args) => {
    if (!noFlag(args, "-s", "--set")) return false;
    const rest = positionals(args, new Set(["-r", "-d", "-f", "-j", "--date", "--file", "--reference"]));
    return rest.every((arg) => arg.startsWith("+"));
  },
  /** `hostname newname` renames the machine. */
  hostname: (args) =>
    args.every((arg) =>
      ["-s", "-f", "-i", "-d", "-I", "--short", "--fqdn", "--domain", "--all-ip-addresses"].includes(arg),
    ),
  /** `file -C` compiles and writes a magic database. */
  file: (args) => noFlag(args, "-C", "--compile"),
  /**
   * `tsc` emits files, which the spec allows: compiling into the project's own
   * configured output directory is ordinary build work. An explicit output
   * path is not — `tsc --outDir /etc/x` is a write to wherever it says.
   */
  tsc: (args) =>
    !args.some((arg) =>
      ["--outdir", "--outfile", "--declarationdir", "--tsbuildinfofile"].includes(
        (arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg).toLowerCase(),
      ),
    ),
  git: (args) => {
    // Walk git's own global flags. `-c k=v`, `--config-env` and `--exec-path`
    // all let a config value run a command (`-c core.pager='sh -c …'`), so a
    // global flag region containing one is never read-only. `-C <path>` only
    // moves the repository and is fine.
    let index = 0;
    while (index < args.length) {
      const arg = args[index] as string;
      if (arg === "-c" || arg === "--config-env" || arg === "--exec-path") return false;
      if (arg.startsWith("--config-env=") || arg.startsWith("--exec-path=")) return false;
      if (arg === "-C" || arg === "--git-dir" || arg === "--work-tree") {
        index += 2;
        continue;
      }
      if (arg.startsWith("-")) {
        index += 1;
        continue;
      }
      break;
    }
    const sub = args[index];
    if (sub === undefined) return true; // bare `git` prints usage.
    const rest = args.slice(index + 1);
    if (GIT_READ_ONLY.has(sub)) {
      if (sub === "branch") return !rest.some((arg) => /^-(d|D|m|M|f|c|C)$/.test(arg) || arg.startsWith("--delete") || arg.startsWith("--move") || arg.startsWith("--force"));
      return true;
    }
    if (sub === "remote") return rest.length === 0 || rest.every((arg) => arg === "-v" || arg === "--verbose" || arg === "show" || !arg.startsWith("-"));
    if (sub === "config") return rest.some((arg) => arg === "--get" || arg === "--get-all" || arg === "--list" || arg === "-l");
    if (sub === "stash") return rest[0] === "list" || rest[0] === "show";
    if (sub === "tag") return rest.length === 0 || rest.every((arg) => arg === "-l" || arg === "--list" || arg === "-n");
    if (sub === "worktree") return rest[0] === "list";
    if (sub === "reflog") return rest.length === 0 || rest[0] === "show";
    if (sub === "notes") return rest[0] === "list" || rest[0] === "show";
    return false;
  },
  npm: (args) => runnerIsReadOnly(args),
  pnpm: (args) => runnerIsReadOnly(args),
  yarn: (args) => runnerIsReadOnly(args),
  bun: (args) => runnerIsReadOnly(args),
  cargo: (args) => {
    const sub = firstWord(args) || args[0] || "";
    if (sub === "fmt") return args.includes("--check");
    return ["check", "build", "test", "clippy", "tree", "metadata", "--version", "-V"].includes(sub);
  },
  go: (args) => ["build", "test", "vet", "list", "version", "env"].includes(firstWord(args)),
  ruff: (args) => firstWord(args) === "check" && noFlag(args, "--fix"),
  eslint: (args) => noFlag(args, "--fix"),
  prettier: (args) => args.some((arg) => arg === "--check" || arg === "-c" || arg === "-l" || arg === "--list-different"),
  // An interpreter runs whatever you hand it. Only version probes are safe.
  node: (args) => args.length === 1 && ["--version", "-v"].includes(args[0] as string),
  python: (args) => pythonIsReadOnly(args),
  python3: (args) => pythonIsReadOnly(args),
  deno: (args) => ["check", "fmt", "lint", "--version"].includes(firstWord(args) || args[0] || ""),
  docker: (args) => ["ps", "images", "version", "info"].includes(firstWord(args)),
  /** `kubectl get secret …` prints the secret. Reading one is a decision. */
  kubectl: (args) =>
    ["get", "describe", "logs", "version"].includes(firstWord(args)) &&
    !args.some((arg) => /(^|[^a-z])secrets?($|[^a-z])/i.test(arg)),
};

/**
 * Commands that are never skipped, whatever their arguments.
 *
 * `env` and `printenv` are both: a wrapper that runs another program
 * (`env FOO=bar rm -rf build`) and a way to print the whole environment,
 * which in a Claude Code session is where the API keys live.
 */
const NEVER_SKIP: Record<string, string> = {
  env: "env runs another program and prints the environment",
  printenv: "printenv prints environment variables, which is where secrets live",
};

function runnerIsReadOnly(args: string[]): boolean {
  const first = firstWord(args);
  if (first === "") return true;
  if (!RUNNER_SUBCOMMANDS.has(first)) return false;
  if (first === "run") {
    const script = args[args.indexOf(first) + 1];
    return script !== undefined && SAFE_SCRIPT.test(script);
  }
  if (first === "test" || first === "lint" || first === "build") return true;
  return true;
}

function pythonIsReadOnly(args: string[]): boolean {
  if (args.length === 1 && ["--version", "-V"].includes(args[0] as string)) return true;
  return args[0] === "-m" && ["pytest", "unittest", "mypy", "ruff"].includes(args[1] ?? "");
}

/** Shells and interpreters: a pipe into one of these is arbitrary execution. */
const INTERPRETERS = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "csh",
  "tcsh",
  "powershell",
  "pwsh",
  "node",
  "deno",
  "bun",
  "python",
  "python3",
  "perl",
  "ruby",
  "php",
  "osascript",
  "eval",
  "exec",
  "source",
  ".",
]);

const PRIVILEGE = new Set(["sudo", "doas", "su", "runas", "pkexec"]);

/**
 * Classify one Bash command.
 *
 * `skip` requires every segment to be recognizably read-only *and* the whole
 * command to be free of redirects, substitutions, variable expansion,
 * grouping, privilege escalation, and pipes into an interpreter.
 */
export function prefilterBash(command: string): Prefilter {
  const scan = scanBash(command);
  const flat = flatten(scan);

  for (const [name, reason, pattern] of RAW_HARD_PATTERNS) {
    if (pattern.test(command)) {
      return { kind: "escalate", reason, pattern: name };
    }
  }
  for (const segment of scan.segments) {
    for (const hard of HARD_PATTERNS) {
      if (hard.matches(segment, flat)) {
        return { kind: "escalate", reason: hard.reason, pattern: hard.name };
      }
    }
  }

  if (scan.segments.length === 0) return { kind: "skip", reason: "empty command" };
  if (scan.features.unbalanced) return { kind: "judge", reason: "unbalanced quoting" };
  if (scan.features.substitution) return { kind: "judge", reason: "command substitution" };
  if (scan.features.redirect) return { kind: "judge", reason: "output redirect" };
  if (scan.features.grouping) return { kind: "judge", reason: "subshell or group" };
  if (scan.features.heredoc) return { kind: "judge", reason: "here-document" };
  if (scan.features.expansion) return { kind: "judge", reason: "variable expansion" };

  for (const [index, segment] of scan.segments.entries()) {
    const command_ = commandOf(segment);
    if (command_ === "") return { kind: "judge", reason: "unparsed segment" };

    // An assignment or a path can replace the program before any allowlist
    // gets a say, so both are checked before the name means anything.
    for (const name of assignmentNames(segment)) {
      if (!BENIGN_ASSIGNMENTS.test(name)) {
        return { kind: "judge", reason: `environment assignment (${name}=) before the command` };
      }
    }
    if (isForeignPath(segment)) {
      return { kind: "judge", reason: `command is path-qualified outside the system bin directories` };
    }

    if (PRIVILEGE.has(command_)) return { kind: "judge", reason: `privilege escalation (${command_})` };
    if (index > 0 && INTERPRETERS.has(command_)) {
      return { kind: "judge", reason: `pipes into an interpreter (${command_})` };
    }
    const never = NEVER_SKIP[command_];
    if (never !== undefined) return { kind: "judge", reason: never };

    const args = argsOf(segment);
    const exec = execOption(args);
    if (exec !== undefined) return { kind: "judge", reason: `${exec} can run a command or write a file` };
    const secret = secretArgument(args);
    if (secret !== undefined) return { kind: "judge", reason: `argument names sensitive material (${secret})` };

    const conditional = CONDITIONAL[command_];
    if (conditional !== undefined) {
      if (!conditional(args)) return { kind: "judge", reason: `${command_} invoked in a non-read-only shape` };
      continue;
    }
    if (!ALWAYS_READ_ONLY.has(command_)) {
      return { kind: "judge", reason: `${command_} is not on the read-only allowlist` };
    }
  }

  return { kind: "skip", reason: "every segment is a read-only allowlisted command" };
}

// --------------------------------------------------------------- file writing

const SENSITIVE_BASENAMES = [
  /^\.env(\..*)?$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.pypirc$/i,
  /^\.git-credentials$/i,
  /^credentials$/i,
  /^authorized_keys$/i,
  /^known_hosts$/i,
  /^\.(bash|zsh)(rc|_profile|env|profile|_login)$/i,
  /^\.profile$/i,
  /^\.bashrc$/i,
  /^\.zshrc$/i,
  /^\.zshenv$/i,
  /^\.zprofile$/i,
  /^\.bash_profile$/i,
  /^\.bash_login$/i,
  /^\.gitconfig$/i,
];

const SENSITIVE_EXTENSIONS = [/\.pem$/i, /\.p12$/i, /\.pfx$/i, /\.key$/i, /\.keystore$/i, /\.jks$/i];

const SENSITIVE_DIRS = new Set([".ssh", ".aws", ".gnupg", ".config/gcloud", ".kube", ".docker"]);

/** True when writing here is a decision a human should make. */
export function isSensitivePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter((part) => part !== "");
  const base = parts[parts.length - 1] ?? "";

  if (SENSITIVE_BASENAMES.some((pattern) => pattern.test(base))) return true;
  if (SENSITIVE_EXTENSIONS.some((pattern) => pattern.test(base))) return true;
  if (parts.some((part) => SENSITIVE_DIRS.has(part))) return true;
  // Claude Code's own configuration: a hook that lets an agent rewrite the
  // permission rules has defeated itself.
  if (/\/\.claude\/settings[^/]*\.json$/i.test(`/${normalized}`)) return true;
  if (/\/\.claude\/(settings|hooks)\//i.test(`/${normalized}`)) return true;
  // Git internals, but not files tracked in the working tree.
  if (parts.includes(".git")) return true;
  return false;
}

export function isInside(cwd: string, path: string): boolean {
  if (!isAbsolute(path)) return true; // Relative paths resolve against cwd.
  const root = resolve(cwd);
  const target = resolve(path);
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

export interface FilePrefilterOptions {
  cwd: string;
  /** strict mode judges even an ordinary in-cwd edit. */
  strict: boolean;
}

export function prefilterFileWrite(path: string | undefined, options: FilePrefilterOptions): Prefilter {
  if (path === undefined || path === "") return { kind: "judge", reason: "no file path in the tool input" };
  if (isSensitivePath(path)) return { kind: "judge", reason: "sensitive path" };
  if (!isInside(options.cwd, path)) return { kind: "judge", reason: "path outside the working directory" };
  if (options.strict) return { kind: "judge", reason: "strict mode judges every edit" };
  return { kind: "skip", reason: "ordinary file inside the working directory" };
}

// ----------------------------------------------------------------- mcp tools

const READ_VERBS = /^(get|list|read|search|query|fetch|describe|find|show|view|inspect|count|resolve)/;

/** `mcp__<server>__<tool>`, or `mcp__plugin_<plugin>_<server>__<tool>`. */
export function mcpToolSegment(toolName: string): string | undefined {
  if (!toolName.startsWith("mcp__")) return undefined;
  const parts = toolName.split("__");
  return parts[parts.length - 1];
}

export function prefilterMcp(toolName: string): Prefilter {
  const tool = mcpToolSegment(toolName);
  if (tool === undefined) return { kind: "judge", reason: "not an MCP tool name" };
  if (READ_VERBS.test(tool.toLowerCase())) {
    return { kind: "skip", reason: "MCP tool name reads as a retrieval" };
  }
  return { kind: "judge", reason: "MCP tool with an unknown effect" };
}

/** This plugin's own tools, whether reached bare or through its bundled server. */
export function isOwnTool(toolName: string): boolean {
  return /^mcp__[a-z0-9_]*jev[a-z0-9_]*__jev_/i.test(toolName);
}

// ------------------------------------------------------------------ dispatch

export interface PrefilterInput {
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd: string;
  strict: boolean;
}

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "Update"]);

export function prefilter(input: PrefilterInput): Prefilter {
  const { toolName } = input;
  if (isOwnTool(toolName)) return { kind: "skip", reason: "this plugin's own tool" };

  if (toolName === "Bash" || toolName === "PowerShell") {
    const command = input.toolInput.command;
    if (typeof command !== "string" || command.trim() === "") {
      return { kind: "judge", reason: "no command in the tool input" };
    }
    if (toolName === "PowerShell") return { kind: "judge", reason: "PowerShell is not tokenized here" };
    return prefilterBash(command);
  }

  if (FILE_TOOLS.has(toolName)) {
    const path = input.toolInput.file_path ?? input.toolInput.notebook_path ?? input.toolInput.path;
    return prefilterFileWrite(typeof path === "string" ? path : undefined, {
      cwd: input.cwd,
      strict: input.strict,
    });
  }

  if (toolName.startsWith("mcp__")) return prefilterMcp(toolName);

  return { kind: "judge", reason: "tool has no prefilter" };
}
