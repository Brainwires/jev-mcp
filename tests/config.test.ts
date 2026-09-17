import { describe, expect, it } from "vitest";
import { DEFAULTS, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies documented defaults", () => {
    const config = loadConfig({ TYPESAFE_API_KEY: "sk-abc" });
    expect(config).toEqual({
      apiKey: "sk-abc",
      baseUrl: DEFAULTS.baseUrl,
      model: DEFAULTS.model,
      timeoutMs: DEFAULTS.timeoutMs,
      maxRetries: DEFAULTS.maxRetries,
      thresholds: { auto: DEFAULTS.autoThreshold, review: DEFAULTS.reviewThreshold },
      maxConcurrency: DEFAULTS.maxConcurrency,
    });
  });

  it("represents a missing API key instead of throwing", () => {
    expect(loadConfig({}).apiKey).toBeNull();
    expect(loadConfig({ TYPESAFE_API_KEY: "" }).apiKey).toBeNull();
    expect(loadConfig({ TYPESAFE_API_KEY: "   " }).apiKey).toBeNull();
  });

  it("reads every override", () => {
    const config = loadConfig({
      TYPESAFE_API_KEY: " sk-abc ",
      TYPESAFE_BASE_URL: "http://localhost:9000/",
      JEV_MODEL: "jev-1.13.0",
      JEV_TIMEOUT_MS: "5000",
      JEV_MAX_RETRIES: "0",
      JEV_AUTO_THRESHOLD: "0.9",
      JEV_REVIEW_THRESHOLD: "0.5",
      JEV_MAX_CONCURRENCY: "8",
    });

    expect(config).toEqual({
      apiKey: "sk-abc",
      baseUrl: "http://localhost:9000",
      model: "jev-1.13.0",
      timeoutMs: 5000,
      maxRetries: 0,
      thresholds: { auto: 0.9, review: 0.5 },
      maxConcurrency: 8,
    });
  });

  it("falls back to the default when an override is blank", () => {
    const config = loadConfig({ TYPESAFE_API_KEY: "k", JEV_MODEL: "  ", JEV_TIMEOUT_MS: "" });
    expect(config.model).toBe(DEFAULTS.model);
    expect(config.timeoutMs).toBe(DEFAULTS.timeoutMs);
  });

  it("rejects malformed numbers with a message naming the variable", () => {
    expect(() => loadConfig({ TYPESAFE_API_KEY: "k", JEV_TIMEOUT_MS: "soon" })).toThrow(/JEV_TIMEOUT_MS/);
    expect(() => loadConfig({ TYPESAFE_API_KEY: "k", JEV_AUTO_THRESHOLD: "1.5" })).toThrow(
      /JEV_AUTO_THRESHOLD/,
    );
    expect(() => loadConfig({ TYPESAFE_API_KEY: "k", JEV_MAX_CONCURRENCY: "0" })).toThrow(
      /JEV_MAX_CONCURRENCY/,
    );
  });

  it("rejects a review threshold above the auto threshold", () => {
    expect(() =>
      loadConfig({ TYPESAFE_API_KEY: "k", JEV_AUTO_THRESHOLD: "0.5", JEV_REVIEW_THRESHOLD: "0.9" }),
    ).toThrow(/must not exceed/);
  });
});

describe("loadConfig — API key sources", () => {
  it("prefers the plugin option over the shell variable", () => {
    expect(loadConfig({ JEV_PLUGIN_API_KEY: "sk-plugin", TYPESAFE_API_KEY: "sk-shell" }).apiKey).toBe("sk-plugin");
  });

  // The plugin manifest always sets JEV_PLUGIN_API_KEY. When the user left the
  // option empty and exported the key in their shell instead, that empty value
  // must not mask it.
  it("falls through an empty or unsubstituted plugin option to the shell variable", () => {
    expect(loadConfig({ JEV_PLUGIN_API_KEY: "", TYPESAFE_API_KEY: "sk-shell" }).apiKey).toBe("sk-shell");
    expect(loadConfig({ JEV_PLUGIN_API_KEY: "  ", TYPESAFE_API_KEY: "sk-shell" }).apiKey).toBe("sk-shell");
    expect(loadConfig({ JEV_PLUGIN_API_KEY: "${user_config.api_key}", TYPESAFE_API_KEY: "sk-shell" }).apiKey).toBe("sk-shell");
  });

  it("reports no key when every source is empty", () => {
    expect(loadConfig({ JEV_PLUGIN_API_KEY: "", TYPESAFE_API_KEY: "" }).apiKey).toBeNull();
  });
});
