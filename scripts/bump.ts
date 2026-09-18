#!/usr/bin/env tsx
/**
 * Set the version in every place that carries one.
 *
 * There are five, and they have to agree: `package.json`, the lockfile,
 * `plugin/.claude-plugin/plugin.json`, the plugin's entry in
 * `.claude-plugin/marketplace.json`, and `SERVER_VERSION` in `src/server.ts`
 * (which is what an MCP client reports). Four of them are easy to forget, and
 * a marketplace whose version disagrees with the plugin it installs is the kind
 * of bug that only shows up on someone else's machine.
 *
 *   npm run bump -- 0.2.0
 *
 * Edits are targeted string replacements rather than parse-and-reserialize, so
 * the diff is one line per file and nothing gets reformatted. Every file is
 * checked before any file is written: a half-applied bump is worse than none.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Semver, without the range syntax: this sets an exact version. */
export const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface Edit {
  /** Path relative to the repo root. */
  file: string;
  /** Matches the version-bearing line; group 1 and 3 are kept verbatim. */
  pattern: RegExp;
  /** How many times the pattern must match. */
  expected: number;
  what: string;
}

/** Escape a package name for use inside a regular expression. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The edits, given the package's own name.
 *
 * The name matters for one file: `package-lock.json` has a `"version"` key for
 * every dependency in the tree — 199 of them here — so the only safe anchor is
 * the `"name"` line immediately above it. Both places the lockfile states the
 * root package's version are preceded by its name, and no dependency shares it.
 */
export function editsFor(packageName: string): Edit[] {
  const name = escape(packageName);
  return [
    {
      file: "package.json",
      // The first `"version"` in package.json is the package's own.
      pattern: /^(\s*"version":\s*")([^"]+)(",?\s*)$/m,
      expected: 1,
      what: "package version",
    },
    {
      file: "package-lock.json",
      pattern: new RegExp(`("name":\\s*"${name}",\\n\\s*"version":\\s*")([^"]+)(")`, "g"),
      expected: 2,
      what: "lockfile version",
    },
    ...TRAILING_EDITS,
  ];
}

const TRAILING_EDITS: Edit[] = [
  {
    file: "plugin/.claude-plugin/plugin.json",
    pattern: /^(\s*"version":\s*")([^"]+)(",?\s*)$/m,
    expected: 1,
    what: "plugin manifest version",
  },
  {
    file: ".claude-plugin/marketplace.json",
    pattern: /^(\s*"version":\s*")([^"]+)(",?\s*)$/m,
    expected: 1,
    what: "marketplace entry version",
  },
  {
    file: "src/server.ts",
    pattern: /^(export const SERVER_VERSION = ")([^"]+)(";)$/m,
    expected: 1,
    what: "SERVER_VERSION",
  },
];

interface Planned {
  file: string;
  next: string;
  from: string[];
  what: string;
}

/** Work out every edit, or explain why the bump cannot be applied. */
export function plan(version: string, read: (file: string) => string): Planned[] {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`"${version}" is not an exact semver version, for example 0.2.0.`);
  }

  const packageName = (JSON.parse(read("package.json")) as { name?: string }).name;
  if (typeof packageName !== "string" || packageName === "") {
    throw new Error("package.json has no `name`, so the lockfile's own version cannot be told from a dependency's.");
  }

  const planned: Planned[] = [];
  for (const edit of editsFor(packageName)) {
    const source = read(edit.file);
    const matches = [...source.matchAll(new RegExp(edit.pattern.source, edit.pattern.flags.includes("g") ? edit.pattern.flags : `${edit.pattern.flags}g`))];
    if (matches.length !== edit.expected) {
      throw new Error(
        `${edit.file}: expected ${edit.expected} version field${edit.expected === 1 ? "" : "s"} to rewrite, ` +
          `found ${matches.length}. The file's shape changed; fix scripts/bump.ts rather than the version by hand.`,
      );
    }

    const from = matches.map((match) => match[2] as string);
    // Only the first `expected` matches are rewritten, in order.
    let seen = 0;
    const next = source.replace(
      new RegExp(edit.pattern.source, edit.pattern.flags.includes("g") ? edit.pattern.flags : `${edit.pattern.flags}g`),
      (_full, head: string, _old: string, tail: string) => {
        seen += 1;
        return seen <= edit.expected ? `${head}${version}${tail}` : _full;
      },
    );
    planned.push({ file: edit.file, next, from, what: edit.what });
  }
  return planned;
}

function main(argv: string[]): number {
  const version = argv[2];
  if (version === undefined || version === "") {
    process.stderr.write("usage: npm run bump -- <version>\n  for example: npm run bump -- 0.2.0\n");
    return 1;
  }

  let planned: Planned[];
  try {
    planned = plan(version, (file) => readFileSync(join(root, file), "utf8"));
  } catch (error) {
    process.stderr.write(`bump failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  for (const item of planned) {
    writeFileSync(join(root, item.file), item.next, "utf8");
    const was = [...new Set(item.from)].join(", ");
    process.stdout.write(`${item.file.padEnd(38)} ${item.what}: ${was} -> ${version}\n`);
  }

  process.stdout.write(
    `\nSet ${planned.length} files to ${version}. Next: update CHANGELOG.md, run \`npm run build\` so the ` +
      `committed plugin bundle matches, and run the tests.\n`,
  );
  return 0;
}

// Only run when invoked directly, so the planner stays importable by tests.
if (process.argv[1] !== undefined && import.meta.url === `file://${resolve(process.argv[1])}`) {
  process.exit(main(process.argv));
}
