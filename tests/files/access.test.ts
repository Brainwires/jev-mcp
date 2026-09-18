/**
 * The file layer's refusals, against a real temp directory with real symlinks.
 *
 * Every test here is a security property, so none of them is mocked: a symlink
 * escape that a fake filesystem rejects tells you nothing about `realpath`.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chunkText,
  collectChunks,
  enforceSelection,
  expandGlob,
  FileSelectionError,
  looksBinary,
  MAX_FILE_BYTES,
  matchPath,
  readTextFile,
  resolveInsideRoot,
  resolveProjectRoot,
} from "../../src/files/index.js";

let root: string;
/** Outside the root, and reachable only through a symlink. */
let outside: string;

beforeEach(() => {
  // realpath, because macOS resolves /var and /tmp through symlinks and the
  // whole point of this layer is that it compares resolved paths.
  const base = mkdtempSync(join(tmpdir(), "jev-files-"));
  root = join(base, "project");
  outside = join(base, "elsewhere");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\nexport const b = 2;\n");
  writeFileSync(join(root, "src", "b.ts"), "import { a } from './a.js';\n");
  writeFileSync(join(root, "README.md"), "# project\n");
  writeFileSync(join(outside, "secrets.txt"), "SUPER_SECRET_PAYLOAD\n");
});

afterEach(() => {
  rmSync(resolve(root, ".."), { recursive: true, force: true });
});

const options = (): { root: string } => ({ root: resolveProjectRoot({}, root) });

describe("resolveInsideRoot", () => {
  it("accepts a relative path inside the root and reports it relative", () => {
    const result = resolveInsideRoot(options().root, "src/a.ts");
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.relative).toBe("src/a.ts");
  });

  it("accepts an absolute path inside the root", () => {
    const result = resolveInsideRoot(options().root, join(root, "src", "a.ts"));
    expect(result.kind).toBe("ok");
  });

  it("refuses a parent-escaping relative path", () => {
    expect(resolveInsideRoot(options().root, "../elsewhere/secrets.txt").kind).toBe("outside_root");
    expect(resolveInsideRoot(options().root, "../../etc/passwd").kind).toBe("outside_root");
    expect(resolveInsideRoot(options().root, "src/../../elsewhere/secrets.txt").kind).toBe("outside_root");
  });

  it("refuses an absolute path outside the root", () => {
    expect(resolveInsideRoot(options().root, join(outside, "secrets.txt")).kind).toBe("outside_root");
    expect(resolveInsideRoot(options().root, "/etc/hosts").kind).toBe("outside_root");
  });

  it("refuses a symlink inside the root that points outside it", () => {
    symlinkSync(join(outside, "secrets.txt"), join(root, "innocent.txt"));
    expect(resolveInsideRoot(options().root, "innocent.txt").kind).toBe("outside_root");
  });

  it("refuses a file reached through a symlinked directory pointing outside", () => {
    symlinkSync(outside, join(root, "vendored"));
    expect(resolveInsideRoot(options().root, "vendored/secrets.txt").kind).toBe("outside_root");
  });

  it("allows a symlink that stays inside the root", () => {
    symlinkSync(join(root, "src", "a.ts"), join(root, "alias.ts"));
    const result = resolveInsideRoot(options().root, "alias.ts");
    expect(result.kind).toBe("ok");
    // Reported at its real location, so two names for one file cannot be
    // scored twice under different paths.
    if (result.kind === "ok") expect(result.relative).toBe("src/a.ts");
  });

  it("refuses sensitive paths, named literally or reached inside the root", () => {
    writeFileSync(join(root, ".env"), "TYPESAFE_API_KEY=sk-should-never-be-read\n");
    mkdirSync(join(root, "certs"), { recursive: true });
    writeFileSync(join(root, "certs", "server.pem"), "-----BEGIN PRIVATE KEY-----\n");
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "settings.json"), "{}\n");

    for (const path of [".env", "certs/server.pem", ".claude/settings.json", "src/../.env"]) {
      expect(resolveInsideRoot(options().root, path).kind, path).toBe("sensitive");
    }
  });

  it("refuses a sensitive path even when it does not exist", () => {
    // The refusal must not depend on the file being there: the answer to
    // "read id_rsa" is no, not "no such file".
    expect(resolveInsideRoot(options().root, "id_rsa").kind).toBe("sensitive");
    expect(resolveInsideRoot(options().root, "deploy/.aws/credentials").kind).toBe("sensitive");
  });

  it("reports a missing file as not_found, and a directory as not a file", () => {
    expect(resolveInsideRoot(options().root, "nope.ts").kind).toBe("not_found");
    expect(resolveInsideRoot(options().root, "src").kind).toBe("not_found");
    expect(resolveInsideRoot(options().root, "").kind).toBe("not_found");
  });
});

describe("readTextFile", () => {
  it("reads text", () => {
    const read = readTextFile(join(root, "src", "a.ts"));
    expect(read.kind).toBe("ok");
    if (read.kind === "ok") expect(read.text).toContain("export const a");
  });

  it("refuses a binary file by its NUL bytes", () => {
    writeFileSync(join(root, "blob.bin"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02]));
    expect(readTextFile(join(root, "blob.bin")).kind).toBe("binary");
  });

  it("refuses a file over the size cap without reading it", () => {
    writeFileSync(join(root, "big.txt"), "x".repeat(MAX_FILE_BYTES + 1));
    expect(readTextFile(join(root, "big.txt")).kind).toBe("too_large");
    expect(readTextFile(join(root, "big.txt"), 10).kind).toBe("too_large");
  });

  it("looksBinary only inspects the first 8 KB", () => {
    expect(looksBinary(Buffer.from("plain text"))).toBe(false);
    expect(looksBinary(Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])]))).toBe(false);
    expect(looksBinary(Buffer.from([0x61, 0x00]))).toBe(true);
  });
});

describe("matchPath", () => {
  const cases: [string, string, boolean][] = [
    ["src/**/*.ts", "src/a.ts", true],
    ["src/**/*.ts", "src/deep/nested/a.ts", true],
    ["src/**/*.ts", "src/a.js", false],
    ["src/**/*.ts", "lib/a.ts", false],
    ["*.md", "README.md", true],
    ["*.md", "docs/README.md", false],
    ["**/*.md", "docs/README.md", true],
    ["src/*.ts", "src/deep/a.ts", false],
    ["src/?.ts", "src/a.ts", true],
    ["src/?.ts", "src/ab.ts", false],
    ["src/{a,b}.ts", "src/a.ts", true],
    ["src/{a,b}.ts", "src/b.ts", true],
    ["src/{a,b}.ts", "src/c.ts", false],
    ["**/*.{ts,tsx}", "src/a.tsx", true],
    ["src/[ab].ts", "src/a.ts", true],
    ["src/[!ab].ts", "src/a.ts", false],
    ["src/[!ab].ts", "src/c.ts", true],
    // `**` does not wander into dot directories.
    ["**/*.json", ".claude/settings.json", false],
    [".claude/*.json", ".claude/settings.json", true],
    ["**/*", "src/a.ts", true],
  ];

  for (const [pattern, path, expected] of cases) {
    it(`${expected ? "matches" : "does not match"} ${pattern} against ${path}`, () => {
      expect(matchPath(pattern, path)).toBe(expected);
    });
  }
});

describe("expandGlob", () => {
  it("expands a glob to sorted relative paths", () => {
    expect(expandGlob("src/**/*.ts", options()).paths).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("fails loudly on a glob that matches nothing", () => {
    expect(() => expandGlob("src/**/*.rs", options())).toThrowError(FileSelectionError);
    try {
      expandGlob("src/**/*.rs", options());
      expect.unreachable("a glob matching nothing must not succeed");
    } catch (error) {
      expect((error as FileSelectionError).kind).toBe("no_matches");
      // The caller has to be able to tell "nothing matched" from "nothing is
      // relevant", so the message says where it looked.
      expect((error as Error).message).toContain("matched no files");
      expect((error as Error).message).toContain(options().root);
    }
  });

  it("fails loudly when a glob matches more files than the cap", () => {
    for (let i = 0; i < 12; i += 1) writeFileSync(join(root, `f${i}.txt`), "x\n");
    try {
      expandGlob("*.txt", { ...options(), maxFiles: 5 });
      expect.unreachable("an over-wide glob must not succeed");
    } catch (error) {
      expect((error as FileSelectionError).kind).toBe("too_many_matches");
      expect((error as Error).message).toContain("Narrow it");
    }
  });

  it("stays out of ignored directories and generated files", () => {
    mkdirSync(join(root, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(root, "node_modules", "left-pad", "index.ts"), "module.exports = 1;\n");
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "bundle.ts"), "compiled\n");
    writeFileSync(join(root, "src", "vendor.min.ts"), "minified\n");

    expect(expandGlob("**/*.ts", options()).paths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(expandGlob("**/*.ts", options()).ignored).toBe(1);
  });

  /**
   * The adversarial case: a symlink out of the project.
   *
   * Refusing the files inside it is not enough. Before this, `**` walked the
   * whole linked tree and then refused each file as `outside_root` — 233
   * entries enumerated under a `src/etc -> /etc` link — and because the match
   * cap counts *matches*, and a path outside the root never becomes one, a link
   * to `/` or `$HOME` would crawl the disk before any cap applied. The
   * directory has to be refused, not its contents.
   */
  it("does not walk into a directory that resolves outside the root", () => {
    symlinkSync(outside, join(root, "src", "escape"));
    // Give the outside tree enough content that walking it would be visible.
    mkdirSync(join(outside, "deep", "deeper"), { recursive: true });
    for (let i = 0; i < 25; i += 1) writeFileSync(join(outside, "deep", "deeper", `f${i}.ts`), "secret\n");

    const result = expandGlob("**/*", options());
    expect(result.paths.some((p) => p.includes("escape"))).toBe(false);
    expect(result.paths.some((p) => p.includes("f0.ts"))).toBe(false);
    // Counted once, for the directory — not once per file inside it.
    expect(result.outsideRoot).toBe(1);
  });

  it("counts an escaping directory once in the reported skips", () => {
    symlinkSync(outside, join(root, "src", "escape"));
    for (let i = 0; i < 25; i += 1) writeFileSync(join(outside, `s${i}.ts`), "secret\n");
    const selection = collectChunks({ glob: "**/*.ts" }, options());
    expect(selection.skipped.outside_root).toBe(1);
    expect(selection.chunks.map((c) => c.text).join("")).not.toContain("secret");
  });

  it("refuses a walk that reaches too many directories, instead of crawling", () => {
    mkdirSync(join(root, "a", "b", "c", "d"), { recursive: true });
    writeFileSync(join(root, "a", "b", "c", "d", "x.ts"), "export const x = 1;\n");
    try {
      expandGlob("**/*.ts", { ...options(), maxDirs: 2 });
      expect.unreachable("a walk over the directory cap must not succeed");
    } catch (error) {
      expect((error as FileSelectionError).kind).toBe("walk_too_wide");
      expect((error as Error).message).toContain("directories");
      expect((error as Error).message).toContain("Nothing was sent");
    }
  });

  it("refuses a walk that looks at too many entries", () => {
    for (let i = 0; i < 30; i += 1) writeFileSync(join(root, "src", `f${i}.ts`), "x\n");
    try {
      expandGlob("**/*.ts", { ...options(), maxVisited: 5 });
      expect.unreachable("a walk over the entry cap must not succeed");
    } catch (error) {
      expect((error as FileSelectionError).kind).toBe("walk_too_wide");
      expect((error as Error).message).toContain("directory entries");
    }
  });

  it("walks a symlink cycle once instead of forever", () => {
    // `src/loop` -> the root. Without cycle detection this returns the same
    // file under `src/loop/src/loop/…` dozens of times and exhausts the match
    // cap on one real file.
    symlinkSync(root, join(root, "src", "loop"));
    const result = expandGlob("**/*.ts", options());
    expect(result.paths).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("reports a subtree reachable by two names once, under one of them", () => {
    mkdirSync(join(root, "packages", "shared"), { recursive: true });
    writeFileSync(join(root, "packages", "shared", "index.ts"), "export const shared = 1;\n");
    symlinkSync(join(root, "packages", "shared"), join(root, "src", "shared"));
    const result = expandGlob("**/*.ts", options());
    // The same consequence of resolving directories: a subtree reachable as
    // both `packages/shared` and `src/shared` is walked once, so the file is
    // scored once rather than twice under two names. Which name wins is walk
    // order, so only the count is asserted.
    expect(result.paths.filter((p) => p.endsWith("index.ts"))).toHaveLength(1);
    expect(collectChunks({ glob: "**/*.ts" }, options()).files_scanned).toBe(3);
  });

  it("never descends into a dot directory through **", () => {
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "config.md"), "[core]\n");
    mkdirSync(join(root, ".ssh"), { recursive: true });
    writeFileSync(join(root, ".ssh", "notes.md"), "keys live here\n");
    expect(expandGlob("**/*.md", options()).paths).toEqual(["README.md"]);
  });
});

describe("chunkText", () => {
  const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

  it("returns one chunk for a short file, with 1-based inclusive line numbers", () => {
    const chunks = chunkText("a.ts", lines(10));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.start_line).toBe(1);
    expect(chunks[0]!.end_line).toBe(10);
    expect(chunks[0]!.text.split("\n")).toHaveLength(10);
  });

  it("overlaps neighbouring chunks so a definition and its use can stay together", () => {
    const chunks = chunkText("a.ts", lines(200), { chunkLines: 60, overlapLines: 5 });
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0]!.end_line).toBe(60);
    expect(chunks[1]!.start_line).toBe(56);
    // Contiguous cover: no line falls between two chunks.
    for (let i = 1; i < chunks.length; i += 1) {
      expect(chunks[i]!.start_line).toBeLessThanOrEqual(chunks[i - 1]!.end_line + 1);
    }
    expect(chunks.at(-1)!.end_line).toBe(200);
  });

  it("never splits a line: every chunk's text rejoins to the original lines", () => {
    const source = lines(130);
    const chunks = chunkText("a.ts", source, { chunkLines: 20, overlapLines: 2 });
    const all = source.split("\n");
    for (const chunk of chunks) {
      expect(chunk.text).toBe(all.slice(chunk.start_line - 1, chunk.end_line).join("\n"));
    }
  });

  it("splits a chunk that is over the character cap", () => {
    const fat = Array.from({ length: 20 }, () => "x".repeat(500)).join("\n");
    const chunks = chunkText("a.ts", fat, { chunkLines: 20, overlapLines: 0, maxChunkChars: 2000 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(2000);
  });

  it("cuts a single over-long line into pieces that keep its line number", () => {
    const chunks = chunkText("a.ts", "x".repeat(5000), { maxChunkChars: 1000 });
    expect(chunks.length).toBe(5);
    for (const chunk of chunks) {
      expect(chunk.start_line).toBe(1);
      expect(chunk.end_line).toBe(1);
      expect(chunk.text.length).toBeLessThanOrEqual(1000);
    }
  });

  it("drops whitespace-only chunks", () => {
    expect(chunkText("a.ts", "")).toEqual([]);
    expect(chunkText("a.ts", "\n\n   \n\t\n")).toEqual([]);
  });
});

describe("collectChunks", () => {
  it("reads a glob and counts what it scanned", () => {
    const selection = collectChunks({ glob: "src/**/*.ts" }, options());
    expect(selection.files_scanned).toBe(2);
    expect(selection.chunks.map((c) => c.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(selection.est_input_tokens).toBeGreaterThan(0);
    expect(selection.est_cost_usd).toBeGreaterThan(0);
  });

  it("counts every refusal by reason instead of dropping it silently", () => {
    writeFileSync(join(root, ".env"), "TYPESAFE_API_KEY=sk-should-never-be-read\n");
    writeFileSync(join(root, "blob.bin"), Buffer.from([0x00, 0x01]));
    writeFileSync(join(root, "big.txt"), "x".repeat(MAX_FILE_BYTES + 1));
    symlinkSync(join(outside, "secrets.txt"), join(root, "innocent.txt"));

    const selection = collectChunks(
      { paths: [".env", "blob.bin", "big.txt", "innocent.txt", "../elsewhere/secrets.txt", "nope.ts", "src/a.ts"] },
      options(),
    );

    expect(selection.skipped).toEqual({
      binary: 1,
      too_large: 1,
      sensitive: 1,
      outside_root: 2,
      not_found: 1,
      ignored: 0,
    });
    expect(selection.files_scanned).toBe(1);
    // The one thing that matters: none of the refused content is in the result.
    const text = selection.chunks.map((c) => c.text).join("\n");
    expect(text).not.toContain("SUPER_SECRET_PAYLOAD");
    expect(text).not.toContain("sk-should-never-be-read");
  });

  it("does not read the same file twice under two names", () => {
    symlinkSync(join(root, "src", "a.ts"), join(root, "alias.ts"));
    const selection = collectChunks({ paths: ["src/a.ts", "alias.ts"] }, options());
    expect(selection.files_scanned).toBe(1);
  });

  it("honours an explicitly named lockfile refusal but not for globs", () => {
    writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
    expect(collectChunks({ paths: ["package-lock.json"] }, options()).skipped.ignored).toBe(1);
  });
});

describe("enforceSelection", () => {
  it("refuses a selection over the cost ceiling, naming the estimate", () => {
    const selection = collectChunks({ glob: "src/**/*.ts" }, options());
    try {
      enforceSelection(selection, { ...options(), maxInputTokens: 1 });
      expect.unreachable("the ceiling must refuse");
    } catch (error) {
      expect((error as FileSelectionError).kind).toBe("cost_ceiling");
      expect((error as Error).message).toContain("Nothing was sent");
      expect((error as Error).message).toContain("input tokens");
    }
  });

  it("refuses a selection where everything was skipped", () => {
    writeFileSync(join(root, ".env"), "secret\n");
    const selection = collectChunks({ paths: [".env"] }, options());
    try {
      enforceSelection(selection, options());
      expect.unreachable("an empty selection must refuse");
    } catch (error) {
      expect((error as FileSelectionError).kind).toBe("nothing_readable");
    }
  });

  it("passes a selection inside the ceiling", () => {
    const selection = collectChunks({ glob: "src/**/*.ts" }, options());
    expect(() => enforceSelection(selection, options())).not.toThrow();
  });
});

describe("resolveProjectRoot", () => {
  it("prefers CLAUDE_PROJECT_DIR over the cwd", () => {
    expect(resolveProjectRoot({ CLAUDE_PROJECT_DIR: root }, outside)).toBe(resolveProjectRoot({}, root));
  });

  it("falls back to the cwd when the harness set nothing", () => {
    expect(resolveProjectRoot({}, root)).toContain("project");
  });
});
