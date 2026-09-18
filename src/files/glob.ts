/**
 * A small glob matcher and directory walker.
 *
 * Written here rather than taken from a dependency because `mcp.mjs` is a
 * committed, bundled artifact: every dependency is bytes in a file someone
 * installs without an install step, and the subset of glob syntax a caller
 * actually types at this tool is small.
 *
 * Supported: `*` (within one segment), `**` (zero or more whole segments),
 * `?` (one character), `[abc]` / `[a-z]` / `[!abc]` classes, and `{a,b}`
 * alternation. Matching is literal elsewhere, and `/` is the only separator.
 *
 * Dotfiles follow the conventional rule: a segment starting with `.` matches
 * only a pattern segment that also starts with a literal `.`. That is what
 * keeps `**` out of `.git`, `.ssh` and `.env` without relying on the ignore
 * list to catch them.
 */

import { readdirSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { FileSelectionError } from "./errors.js";

/** Directories and files a scan stays out of unless a caller names them. */
export const DEFAULT_IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "target",
  "vendor",
  "coverage",
  ".turbo",
  ".venv",
  "__pycache__",
]);

const LOCKFILES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "Cargo.lock",
  "poetry.lock",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
  "uv.lock",
]);

/** True for generated files whose content is never what a caller meant. */
export function isIgnoredFile(basename: string): boolean {
  if (LOCKFILES.has(basename)) return true;
  return /\.min\.[a-z0-9]+$/i.test(basename) || /\.map$/i.test(basename);
}

/** Expand `{a,b}` alternations into separate patterns, outermost group first. */
export function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf("{");
  if (open === -1) return [pattern];

  let depth = 0;
  let close = -1;
  const parts: string[] = [];
  let current = "";
  for (let i = open; i < pattern.length; i += 1) {
    const char = pattern[i] as string;
    if (char === "{") {
      depth += 1;
      if (depth === 1) continue;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        parts.push(current);
        break;
      }
    } else if (char === "," && depth === 1) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }

  // An unbalanced `{` is a literal brace, not a syntax error.
  if (close === -1) return [pattern];

  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  return parts.flatMap((part) => expandBraces(`${head}${part}${tail}`));
}

/** Compile one pattern segment to an anchored regex. */
function segmentRegex(segment: string): RegExp {
  let source = "^";
  let index = 0;
  while (index < segment.length) {
    const char = segment[index] as string;
    if (char === "*") {
      source += "[^/]*";
      index += 1;
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }
    if (char === "[") {
      const close = segment.indexOf("]", index + 1);
      if (close !== -1) {
        const body = segment.slice(index + 1, close);
        const negated = body.startsWith("!") || body.startsWith("^");
        const inner = negated ? body.slice(1) : body;
        source += `[${negated ? "^" : ""}${inner.replace(/[\\\]]/g, "\\$&")}]`;
        index = close + 1;
        continue;
      }
    }
    source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    index += 1;
  }
  return new RegExp(`${source}$`);
}

interface CompiledSegment {
  /** `**` consumes any number of whole segments. */
  globstar: boolean;
  regex: RegExp;
  /** The pattern segment starts with a literal dot, so dot entries may match. */
  dot: boolean;
}

export interface CompiledPattern {
  segments: CompiledSegment[];
}

export function compilePattern(pattern: string): CompiledPattern {
  const segments = pattern
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .map((segment) => ({
      globstar: segment === "**",
      regex: segmentRegex(segment),
      dot: segment.startsWith("."),
    }));
  return { segments };
}

/**
 * Advance the set of live pattern positions by one path segment.
 *
 * States are indices into `segments`; `**` both stays put and steps forward,
 * which is what lets one pattern match at several depths at once.
 */
function step(pattern: CompiledPattern, states: readonly number[], name: string): number[] {
  const next = new Set<number>();
  const hidden = name.startsWith(".");
  for (const state of states) {
    const segment = pattern.segments[state];
    if (segment === undefined) continue;
    if (segment.globstar) {
      // `**` never descends into a dot directory on its own.
      if (!hidden) next.add(state);
      for (const forward of closure(pattern, state + 1)) {
        const target = pattern.segments[forward];
        if (target === undefined) continue;
        if (hidden && !target.dot) continue;
        if (target.regex.test(name)) next.add(forward + 1);
      }
      continue;
    }
    if (hidden && !segment.dot) continue;
    if (segment.regex.test(name)) next.add(state + 1);
  }
  return [...next];
}

/** Positions reachable from `state` without consuming a segment. */
function closure(pattern: CompiledPattern, state: number): number[] {
  const out: number[] = [];
  let index = state;
  for (;;) {
    out.push(index);
    const segment = pattern.segments[index];
    if (segment?.globstar !== true) break;
    index += 1;
  }
  return out;
}

/** A state set that has consumed the whole pattern. */
function accepts(pattern: CompiledPattern, states: readonly number[]): boolean {
  return states.some((state) => closure(pattern, state).some((s) => s >= pattern.segments.length));
}

/** Test a `/`-separated relative path against a pattern. Pure. */
export function matchPath(pattern: string, path: string): boolean {
  const names = path.replace(/\\/g, "/").split("/").filter((n) => n !== "");
  return expandBraces(pattern).some((expanded) => {
    const compiled = compilePattern(expanded);
    let states = closure(compiled, 0);
    for (const name of names) {
      states = step(compiled, states, name);
      if (states.length === 0) return false;
    }
    return accepts(compiled, states);
  });
}

/** Most directories one glob may walk into. */
export const MAX_DIRECTORIES = 20_000;
/** Most directory entries one glob may look at. */
export const MAX_ENTRIES = 200_000;

export interface GlobOptions {
  /** Absolute, realpath-resolved directory the pattern is relative to. */
  root: string;
  /** Stop after this many matches and report it as an error. */
  limit: number;
  /** Directories to prune. */
  ignoredDirs?: Set<string>;
  /** Hard ceiling on directory entries visited, so a walk always terminates. */
  maxVisited?: number;
  /** Hard ceiling on directories entered. */
  maxDirs?: number;
}

export interface GlobResult {
  /** Matched paths, relative to root, `/`-separated, sorted. */
  paths: string[];
  /** True when the walk stopped at `limit`. */
  truncated: boolean;
  /** Files skipped as generated output (lockfiles, `*.min.*`, sourcemaps). */
  ignored: number;
  /** Directories not entered because they resolve outside the root. */
  outsideRoot: number;
}

function isInsideRoot(root: string, target: string): boolean {
  if (target === root) return true;
  return target.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Walk the tree under `root`, pruning directories the pattern can no longer
 * match and directories on the ignore list.
 *
 * Pruning is why this is a walk rather than a full listing plus a filter: a
 * project with a `node_modules` is otherwise most of the work.
 */
export function globFiles(pattern: string, options: GlobOptions): GlobResult {
  const ignoredDirs = options.ignoredDirs ?? DEFAULT_IGNORED_DIRS;
  const maxEntries = options.maxVisited ?? MAX_ENTRIES;
  const maxDirs = options.maxDirs ?? MAX_DIRECTORIES;
  const compiled = expandBraces(pattern).map((expanded) => compilePattern(expanded));

  const paths: string[] = [];
  let ignored = 0;
  let visited = 0;
  let dirs = 0;
  let outsideRoot = 0;
  let truncated = false;
  /**
   * Real directories already walked.
   *
   * A symlink inside the project pointing at one of its own ancestors is a
   * cycle, and without this the walk re-enters it at every depth: one real file
   * comes back as dozens of `a/b/loop/b/loop/…/x.ts` paths, which is both
   * nonsense and enough to exhaust the match cap on a single file. Comparing
   * resolved directories is the fix; a symlink to a *sibling* subtree is still
   * followed once, which is what a caller globbing a monorepo expects.
   */
  const seenDirs = new Set<string>();

  const walk = (relative: string, states: number[][]): void => {
    if (truncated) return;
    let entries: { name: string; isDirectory: boolean; isFile: boolean }[];
    try {
      entries = readdirSync(join(options.root, relative), { withFileTypes: true }).map((entry) => {
        if (!entry.isSymbolicLink()) {
          return { name: entry.name, isDirectory: entry.isDirectory(), isFile: entry.isFile() };
        }
        /**
         * A symlink's own dirent says nothing about what it points at, and
         * guessing "both" made a link to a directory come back as a file
         * match — which the reader then had to refuse as "not a file". One
         * `stat` per symlink settles it; symlinks are rare enough for that to
         * be free, and a broken one is neither.
         */
        try {
          const target = statSync(join(options.root, relative, entry.name));
          return { name: entry.name, isDirectory: target.isDirectory(), isFile: target.isFile() };
        } catch {
          return { name: entry.name, isDirectory: false, isFile: false };
        }
      });
    } catch {
      return; // Unreadable directory: not this tool's business to report.
    }

    for (const entry of entries) {
      visited += 1;
      if (visited > maxEntries) {
        throw new FileSelectionError(
          "walk_too_wide",
          `Expanding ${JSON.stringify(pattern)} looked at more than ${maxEntries.toLocaleString("en-US")} ` +
            `directory entries without finishing. Narrow the glob to a subdirectory. Nothing was sent.`,
        );
      }
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      const nextStates = compiled.map((p, index) => step(p, states[index] as number[], entry.name));

      if (entry.isFile && nextStates.some((s, index) => accepts(compiled[index] as CompiledPattern, s))) {
        if (isIgnoredFile(entry.name)) {
          ignored += 1;
        } else {
          paths.push(child);
          if (paths.length >= options.limit + 1) {
            truncated = true;
            return;
          }
        }
      }

      if (entry.isDirectory && !ignoredDirs.has(entry.name) && nextStates.some((s) => s.length > 0)) {
        let real: string;
        try {
          real = realpathSync(join(options.root, child));
        } catch {
          continue; // A broken symlink is not a directory to walk.
        }
        /**
         * Refuse the directory, not its contents.
         *
         * A symlink like `src/etc -> /etc` used to be walked in full and then
         * refused file by file: 233 entries enumerated to report 233 refusals,
         * and a link to `/` or `$HOME` would crawl the disk first, because the
         * match cap counts matches and a path outside the root never becomes
         * one. Checking the directory prunes the whole subtree for one
         * `outside_root`, which is also the honest count.
         */
        if (!isInsideRoot(options.root, real)) {
          outsideRoot += 1;
          continue;
        }
        if (seenDirs.has(real)) continue;
        seenDirs.add(real);
        dirs += 1;
        if (dirs > maxDirs) {
          throw new FileSelectionError(
            "walk_too_wide",
            `Expanding ${JSON.stringify(pattern)} reached more than ${maxDirs.toLocaleString("en-US")} ` +
              `directories without finishing. Narrow the glob to a subdirectory. Nothing was sent.`,
          );
        }
        walk(child, nextStates);
        if (truncated) return;
      }
    }
  };

  walk("", compiled.map((p) => closure(p, 0)));
  return { paths: paths.sort(), truncated, ignored, outsideRoot };
}
