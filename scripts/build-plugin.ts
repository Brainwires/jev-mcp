/**
 * Bundle the plugin's two executables.
 *
 * Claude Code does not run an install step for a plugin, so whatever ships in
 * `plugin/dist/` has to be self-contained and committed. Two bundles, because
 * they have opposite constraints: `mcp.mjs` needs the MCP SDK and zod, and
 * `hook.mjs` must contain neither — it runs on every tool call, so its cold
 * start is a tax on the whole session.
 *
 * The check at the end is the part that matters. It is easy to add an import to
 * a hook handler that quietly drags the SDK back in, and the only way to notice
 * is to look at what came out.
 */

import { build, type Metafile } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "plugin", "dist");

/** Packages that must never reach the hook bundle. */
export const HOOK_FORBIDDEN = ["@modelcontextprotocol", "zod"];

interface Target {
  entry: string;
  out: string;
  minify: boolean;
  forbidden: string[];
}

const TARGETS: Target[] = [
  // Left unminified on purpose: when a hook misbehaves in someone's session,
  // the stack trace in the decision log should name a function.
  { entry: "src/hooks/cli.ts", out: "hook.mjs", minify: false, forbidden: HOOK_FORBIDDEN },
  { entry: "src/index.ts", out: "mcp.mjs", minify: false, forbidden: [] },
];

/** Which node_modules packages ended up in a bundle. */
export function bundledPackages(metafile: Metafile): Set<string> {
  const packages = new Set<string>();
  for (const path of Object.keys(metafile.inputs)) {
    const match = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(path);
    if (match?.[1] !== undefined) packages.add(match[1]);
  }
  return packages;
}

async function main(): Promise<void> {
  const failures: string[] = [];

  for (const target of TARGETS) {
    const result = await build({
      entryPoints: [join(root, target.entry)],
      outfile: join(outDir, target.out),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      minify: target.minify,
      sourcemap: false,
      metafile: true,
      // No shebang banner: hooks.json and plugin.json both invoke `node <file>`.
      logLevel: "warning",
    });

    const packages = [...bundledPackages(result.metafile)].sort();
    const bytes = readFileSync(join(outDir, target.out)).byteLength;
    const found = target.forbidden.filter((name) => packages.some((pkg) => pkg === name || pkg.startsWith(`${name}/`)));
    if (found.length > 0) failures.push(`${target.out} must not bundle ${found.join(", ")}`);

    process.stdout.write(
      `${target.out.padEnd(9)} ${String(bytes).padStart(8)} bytes  (${(bytes / 1024).toFixed(1)} KiB)  deps: ${
        packages.length === 0 ? "none" : packages.join(", ")
      }\n`,
    );
  }

  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`error: ${failure}\n`);
    process.exit(1);
  }
}

await main();
