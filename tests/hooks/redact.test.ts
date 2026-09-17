/**
 * Redaction. Applied before anything is logged and before anything is sent to
 * a third-party API, so the cost of a miss is real.
 */

import { describe, expect, it } from "vitest";
import { compactJson, redact, redactAndClamp } from "../../src/hooks/redact.js";

const SECRETS: [string, string][] = [
  ["sk-abcdefghijklmnopqrstuvwxyz0123", "an OpenAI-shaped key"],
  ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "a GitHub personal token"],
  ["github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz", "a fine-grained GitHub token"],
  ["AKIAIOSFODNN7EXAMPLE", "an AWS access key id"],
  ["xoxb-123456789012-abcdefghijklmnop", "a Slack bot token"],
  ["AIzaSyA1234567890abcdefghijklmnopqrstu", "a Google API key"],
  ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop", "a JWT"],
  ["deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "a long hex blob"],
];

describe("redact", () => {
  for (const [secret, label] of SECRETS) {
    it(`masks ${label}`, () => {
      const masked = redact(`the value is ${secret} ok`);
      expect(masked).not.toContain(secret);
      expect(masked).toMatch(/REDACTED/);
    });
  }

  it("masks an Authorization header but keeps the scheme", () => {
    const masked = redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz");
    expect(masked).toContain("Bearer [REDACTED]");
    expect(masked).not.toContain("abcdefghij");
  });

  it("masks key=value and key: value forms", () => {
    for (const input of [
      "password=hunter2xyz",
      "PASSWORD: hunter2xyz",
      "api_key=abcd1234efgh",
      'secret="topsecretvalue"',
      "access-token: abcd1234efgh",
    ]) {
      expect(redact(input), input).toContain("[REDACTED]");
      expect(redact(input), input).not.toMatch(/hunter2xyz|abcd1234efgh|topsecretvalue/);
    }
  });

  it("masks a PEM block but leaves a marker", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQ\nnope\n-----END RSA PRIVATE KEY-----";
    const masked = redact(`before ${pem} after`);
    expect(masked).toBe("before [REDACTED PRIVATE KEY] after");
  });

  it("leaves ordinary text alone", () => {
    const text = "Refactor src/parser.ts so the tokenizer is separate. Run npm test -- --run.";
    expect(redact(text)).toBe(text);
  });

  it("does not mangle a short hex colour or a git short sha", () => {
    expect(redact("colour #c0392b and commit a1b2c3d")).toBe("colour #c0392b and commit a1b2c3d");
  });

  it("is safe to apply twice", () => {
    const once = redact("password=hunter2xyz");
    expect(redact(once)).toBe(once);
  });
});

describe("redactAndClamp", () => {
  it("leaves short text untouched", () => {
    expect(redactAndClamp("hello", 100)).toBe("hello");
  });

  it("truncates with a marker", () => {
    const clamped = redactAndClamp("x".repeat(500), 100);
    expect(clamped.length).toBeLessThanOrEqual(100);
    expect(clamped).toContain("truncated");
  });

  it("redacts before truncating", () => {
    const clamped = redactAndClamp(`${"a".repeat(50)} ghp_abcdefghijklmnopqrstuvwxyz0123456789`, 200);
    expect(clamped).not.toContain("ghp_abcdef");
  });
});

describe("compactJson", () => {
  it("passes a string through", () => {
    expect(compactJson("x")).toBe("x");
  });

  it("stringifies an object compactly", () => {
    expect(compactJson({ a: 1, b: [2] })).toBe('{"a":1,"b":[2]}');
  });

  it("survives a circular structure", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => compactJson(circular)).not.toThrow();
  });
});
