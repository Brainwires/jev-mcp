/**
 * Hook configuration. It never throws: a typo in a plugin option must not
 * break someone's session.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HOOK_DEFAULTS, installIdFromScriptPath, loadHookConfig, resolveDataDir } from "../../src/hooks/config.js";

describe("loadHookConfig", () => {
  it("uses the documented defaults with an empty environment", () => {
    const config = loadHookConfig({});
    expect(config.apiKey).toBeNull();
    expect(config.gateMode).toBe("standard");
    expect(config.stopCheck).toBe(true);
    expect(config.screenResults).toBe(true);
    expect(config.routePrompts).toBe(false);
    expect(config.autoThreshold).toBe(0.85);
    expect(config.timeoutMs).toBe(HOOK_DEFAULTS.timeoutMs);
    expect(config.maxRetries).toBe(0);
    expect(config.warnings).toEqual([]);
  });

  it("prefers a plugin option over the env fallback", () => {
    const config = loadHookConfig({
      CLAUDE_PLUGIN_OPTION_API_KEY: "sk-from-plugin",
      TYPESAFE_API_KEY: "sk-from-env",
    });
    expect(config.apiKey).toBe("sk-from-plugin");
  });

  it("falls back to the env var when no plugin option is set", () => {
    expect(loadHookConfig({ TYPESAFE_API_KEY: "sk-from-env" }).apiKey).toBe("sk-from-env");
  });

  it("treats an empty option as unset", () => {
    expect(loadHookConfig({ CLAUDE_PLUGIN_OPTION_API_KEY: "   ", TYPESAFE_API_KEY: "sk-env" }).apiKey).toBe("sk-env");
  });

  it("reads every gate mode", () => {
    for (const mode of ["off", "standard", "strict"]) {
      expect(loadHookConfig({ CLAUDE_PLUGIN_OPTION_GATE_MODE: mode }).gateMode).toBe(mode);
    }
    expect(loadHookConfig({ CLAUDE_PLUGIN_OPTION_GATE_MODE: "STRICT" }).gateMode).toBe("strict");
  });

  it("records a warning and keeps going on a bad gate mode", () => {
    const config = loadHookConfig({ CLAUDE_PLUGIN_OPTION_GATE_MODE: "maybe" });
    expect(config.gateMode).toBe("standard");
    expect(config.warnings.join(" ")).toContain("gate_mode");
  });

  it("reads booleans in every documented spelling", () => {
    for (const value of ["true", "1", "yes", "on", "TRUE"]) {
      expect(loadHookConfig({ CLAUDE_PLUGIN_OPTION_ROUTE_PROMPTS: value }).routePrompts, value).toBe(true);
    }
    for (const value of ["false", "0", "no", "off"]) {
      expect(loadHookConfig({ CLAUDE_PLUGIN_OPTION_STOP_CHECK: value }).stopCheck, value).toBe(false);
    }
  });

  it("warns on a boolean it cannot read", () => {
    const config = loadHookConfig({ CLAUDE_PLUGIN_OPTION_STOP_CHECK: "sometimes" });
    expect(config.stopCheck).toBe(true);
    expect(config.warnings.join(" ")).toContain("stop_check");
  });

  it("reads a threshold and rejects one out of range", () => {
    expect(loadHookConfig({ CLAUDE_PLUGIN_OPTION_AUTO_THRESHOLD: "0.9" }).autoThreshold).toBe(0.9);
    const bad = loadHookConfig({ CLAUDE_PLUGIN_OPTION_AUTO_THRESHOLD: "7" });
    expect(bad.autoThreshold).toBe(0.85);
    expect(bad.warnings.join(" ")).toContain("auto_threshold");
  });

  it("never lets the review threshold exceed the auto threshold", () => {
    expect(loadHookConfig({ CLAUDE_PLUGIN_OPTION_AUTO_THRESHOLD: "0.5" }).reviewThreshold).toBeLessThanOrEqual(0.5);
  });

  it("honours JEV_HOOKS_DISABLE", () => {
    expect(loadHookConfig({ JEV_HOOKS_DISABLE: "1" }).disabled).toBe(true);
    expect(loadHookConfig({}).disabled).toBe(false);
  });

  it("strips a trailing slash from the base url", () => {
    expect(loadHookConfig({ TYPESAFE_BASE_URL: "https://x.example/" }).baseUrl).toBe("https://x.example");
  });
});

describe("resolveDataDir", () => {
  it("uses CLAUDE_PLUGIN_DATA when Claude Code provides it", () => {
    expect(resolveDataDir({ CLAUDE_PLUGIN_DATA: "/tmp/data" })).toBe("/tmp/data");
  });

  it("falls back to the documented location under the home directory", () => {
    expect(resolveDataDir({ HOME: "/home/dev" })).toBe(join("/home/dev", ".claude", "plugins", "data", "jev"));
    expect(resolveDataDir({})).toBe(join(homedir(), ".claude", "plugins", "data", "jev"));
  });

  // A /jev:* command runs through the Bash tool, where CLAUDE_PLUGIN_DATA is not
  // exported. It has to land on the directory the hooks write to.
  it("derives the install id from an installed plugin's script path", () => {
    const script = "/home/dev/.claude/plugins/cache/brainwires-jev/jev/0.1.0/dist/hook.mjs";
    expect(resolveDataDir({ HOME: "/home/dev" }, script)).toBe(
      join("/home/dev", ".claude", "plugins", "data", "jev-brainwires-jev"),
    );
    expect(installIdFromScriptPath("C:\\Users\\dev\\.claude\\plugins\\cache\\my.market\\jev\\1.0.0\\dist\\hook.mjs")).toBe(
      "jev-my-market",
    );
  });

  it("prefers CLAUDE_PLUGIN_DATA over the derived id, and ignores paths outside the plugin cache", () => {
    const script = "/home/dev/.claude/plugins/cache/brainwires-jev/jev/0.1.0/dist/hook.mjs";
    expect(resolveDataDir({ CLAUDE_PLUGIN_DATA: "/tmp/data" }, script)).toBe("/tmp/data");
    expect(installIdFromScriptPath("/repo/jev-mcp/plugin/dist/hook.mjs")).toBeUndefined();
    expect(installIdFromScriptPath("/x/cache/a/b/1/dist/hook.mjs")).toBeUndefined();
    expect(installIdFromScriptPath(undefined)).toBeUndefined();
  });
});
