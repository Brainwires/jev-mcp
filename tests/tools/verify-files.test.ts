/**
 * `jev_verify` over a file, and the merge that makes chunked evidence honest.
 *
 * The merge is the part worth testing hard: once evidence is split, every claim
 * gets several answers, and "not addressed in this chunk" is the answer every
 * chunk gives about the rest of the document. A merge that treated that as a
 * verdict would report a well-supported claim as unsupported for any file large
 * enough to split.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileSelectionError } from "../../src/files/index.js";
import * as verifyTool from "../../src/tools/verify.js";
import type { Answer, ChoiceAnswer } from "../../src/decision/types.js";
import { FakeModel, choice, testConfig } from "../helpers/fake-model.js";

const SECRET = "SK-LIVE-NEVER-SEND-THIS-VALUE";

let root: string;
let outside: string;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "jev-verify-"));
  root = join(base, "project");
  outside = join(base, "elsewhere");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(
    join(root, "CHANGELOG.md"),
    ["# Changelog", "", "## 0.2.0", "", "- Added path-based tools.", "- Fixed the scope bar.", ""].join("\n"),
  );
  writeFileSync(join(root, ".env"), `TYPESAFE_API_KEY=${SECRET}\n`);
  writeFileSync(join(outside, "secrets.txt"), `${SECRET}\n`);
});

afterEach(() => {
  rmSync(resolve(root, ".."), { recursive: true, force: true });
});

const config = () => ({ ...testConfig, files: { root } });

/** Answer every claim question with one verdict. */
function verdict(picked: string, probability = 0.95): (call: { questions: Record<string, unknown> }) => Record<string, Answer> {
  const rest = (1 - probability) / 2;
  const probabilities: Record<string, number> = { supported: rest, contradicted: rest, not_addressed: rest };
  probabilities[picked] = probability;
  return (call) => {
    const answers: Record<string, Answer> = {};
    for (const id of Object.keys(call.questions)) answers[id] = choice(picked, probabilities, probability);
    return answers;
  };
}

describe("jev_verify source selection", () => {
  it("requires exactly one of evidence or evidence_path", async () => {
    const model = new FakeModel(verdict("supported"));
    for (const input of [{}, { evidence: "x", evidence_path: "CHANGELOG.md" }]) {
      await expect(
        verifyTool.run(model, { claims: ["c"], ...input } as never, config()),
      ).rejects.toThrowError(FileSelectionError);
    }
    expect(model.calls).toHaveLength(0);
  });

  it("rejects a line window on inline evidence, where it means nothing", async () => {
    const model = new FakeModel(verdict("supported"));
    await expect(
      verifyTool.run(model, { claims: ["c"], evidence: "x", start_line: 2 }, config()),
    ).rejects.toThrowError(/start_line/);
  });

  it("leaves the inline-evidence path unchanged, with no line range reported", async () => {
    const model = new FakeModel(verdict("supported"));
    const result = await verifyTool.run(model, { claims: ["c"], evidence: "c is true" }, config());
    expect(result.evidence_chunks).toBe(1);
    expect(result.claims[0]!.where).toBeUndefined();
    expect(result.evidence_path).toBeUndefined();
    expect(result.est_cost_usd).toBeUndefined();
    expect(model.calls[0]!.state).toEqual({ evidence: "c is true", claims: ["c"] });
  });
});

describe("jev_verify over a file", () => {
  it("reads the named file and reports where the answer came from", async () => {
    const model = new FakeModel(verdict("supported"));
    const result = await verifyTool.run(
      model,
      { claims: ["0.2.0 added path-based tools."], evidence_path: "CHANGELOG.md" },
      config(),
    );

    expect(result.evidence_path).toBe("CHANGELOG.md");
    expect(result.claims[0]!.verdict).toBe("supported");
    expect(result.claims[0]!.where).toEqual({ start_line: 1, end_line: 7 });
    expect(result.est_cost_usd).toBeGreaterThan(0);
    expect(JSON.stringify(model.calls)).toContain("Added path-based tools");
  });

  it("honours a line window, in the file's own coordinates", async () => {
    const model = new FakeModel(verdict("supported"));
    const result = await verifyTool.run(
      model,
      { claims: ["c"], evidence_path: "CHANGELOG.md", start_line: 3, end_line: 5 },
      config(),
    );
    expect(result.claims[0]!.where).toEqual({ start_line: 3, end_line: 5 });
    const state = model.calls[0]!.state as { evidence: string };
    expect(state.evidence).toBe("## 0.2.0\n\n- Added path-based tools.");
    expect(state.evidence).not.toContain("# Changelog");
  });

  it("refuses an inverted window", async () => {
    const model = new FakeModel(verdict("supported"));
    await expect(
      verifyTool.run(model, { claims: ["c"], evidence_path: "CHANGELOG.md", start_line: 5, end_line: 2 }, config()),
    ).rejects.toThrowError(/before start_line/);
    expect(model.calls).toHaveLength(0);
  });

  it("never reads a sensitive file, and says so", async () => {
    const model = new FakeModel(verdict("supported"));
    await expect(
      verifyTool.run(model, { claims: ["there is a key"], evidence_path: ".env" }, config()),
    ).rejects.toThrowError(/credentials/);
    expect(model.calls).toHaveLength(0);
    expect(JSON.stringify(model.calls)).not.toContain(SECRET);
  });

  it("refuses evidence outside the root, including through a symlink", async () => {
    symlinkSync(join(outside, "secrets.txt"), join(root, "innocent.txt"));
    const model = new FakeModel(verdict("supported"));
    for (const path of ["../elsewhere/secrets.txt", join(outside, "secrets.txt"), "innocent.txt"]) {
      await expect(
        verifyTool.run(model, { claims: ["c"], evidence_path: path }, config()),
      ).rejects.toThrowError(/outside the project root/);
    }
    expect(model.calls).toHaveLength(0);
  });

  it("refuses a missing file clearly", async () => {
    const model = new FakeModel(verdict("supported"));
    await expect(
      verifyTool.run(model, { claims: ["c"], evidence_path: "nope.md" }, config()),
    ).rejects.toThrowError(/not a readable file/);
  });

  it("refuses over the cost ceiling before sending anything", async () => {
    const model = new FakeModel(verdict("supported"));
    await expect(
      verifyTool.run(
        model,
        { claims: ["c"], evidence_path: "CHANGELOG.md" },
        { ...testConfig, files: { root, maxInputTokens: 1 } },
      ),
    ).rejects.toThrowError(/ceiling/);
    expect(model.calls).toHaveLength(0);
  });
});

describe("packEvidence", () => {
  it("returns one piece when the evidence fits", () => {
    const pieces = verifyTool.packEvidence("line one\nline two", ["c"]);
    expect(pieces).toEqual([{ text: "line one\nline two", start_line: 1, end_line: 2 }]);
  });

  it("offsets line numbers by the window's first line", () => {
    const pieces = verifyTool.packEvidence("a\nb\nc", ["c"], 10);
    expect(pieces[0]!.start_line).toBe(10);
    expect(pieces[0]!.end_line).toBe(12);
  });

  it("splits oversized evidence into overlapping pieces that cover every line", () => {
    const text = Array.from({ length: 400 }, (_, i) => `line ${i + 1} ${"x".repeat(200)}`).join("\n");
    const pieces = verifyTool.packEvidence(text, ["c"], 1, { total: 4000, statePlusLongestQuestion: 3000 });
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces[0]!.start_line).toBe(1);
    expect(pieces.at(-1)!.end_line).toBe(400);
    for (let i = 1; i < pieces.length; i += 1) {
      // No gap: the next piece starts no later than the line after this one.
      expect(pieces[i]!.start_line).toBeLessThanOrEqual(pieces[i - 1]!.end_line + 1);
    }
  });

  it("refuses when one line cannot be verified on its own", () => {
    expect(() =>
      verifyTool.packEvidence("x".repeat(100_000), ["c"], 1, { total: 500, statePlusLongestQuestion: 400 }),
    ).toThrowError(/too long to verify/);
  });
});

describe("mergeClaim", () => {
  const thresholds = { auto: 0.85, review: 0.6 };
  const piece = (start: number, end: number) => ({ text: "…", start_line: start, end_line: end });
  const answer = (picked: string, probs: Record<string, number>, confidence: number): ChoiceAnswer =>
    choice(picked, probs, confidence) as ChoiceAnswer;

  it("prefers the piece that was sure of something over one that was not", () => {
    const result = verifyTool.mergeClaim(
      "c",
      [
        { piece: piece(1, 60), answer: answer("not_addressed", { supported: 0.02, contradicted: 0.02, not_addressed: 0.96 }, 0.96) },
        { piece: piece(56, 120), answer: answer("supported", { supported: 0.94, contradicted: 0.03, not_addressed: 0.03 }, 0.94) },
      ],
      thresholds,
      true,
    );
    expect(result.verdict).toBe("supported");
    expect(result.gate).toBe("auto");
    expect(result.where).toEqual({ start_line: 56, end_line: 120 });
  });

  it("stays not_addressed only when every piece said so", () => {
    const result = verifyTool.mergeClaim(
      "c",
      [
        { piece: piece(1, 60), answer: answer("not_addressed", { supported: 0.02, contradicted: 0.02, not_addressed: 0.96 }, 0.96) },
        { piece: piece(56, 120), answer: answer("not_addressed", { supported: 0.05, contradicted: 0.05, not_addressed: 0.9 }, 0.9) },
      ],
      thresholds,
      true,
    );
    expect(result.verdict).toBe("not_addressed");
  });

  it("reports conflicting, and never automatic, when one piece firmly supports and another firmly contradicts", () => {
    const result = verifyTool.mergeClaim(
      "c",
      [
        { piece: piece(1, 60), answer: answer("supported", { supported: 0.95, contradicted: 0.03, not_addressed: 0.02 }, 0.95) },
        { piece: piece(56, 120), answer: answer("contradicted", { supported: 0.02, contradicted: 0.93, not_addressed: 0.05 }, 0.93) },
      ],
      thresholds,
      true,
    );
    expect(result.verdict).toBe("conflicting");
    expect(result.gate).toBe("escalate");
  });

  it("is not conflicting when the disagreement is not firm on both sides", () => {
    const result = verifyTool.mergeClaim(
      "c",
      [
        { piece: piece(1, 60), answer: answer("supported", { supported: 0.95, contradicted: 0.03, not_addressed: 0.02 }, 0.95) },
        { piece: piece(56, 120), answer: answer("contradicted", { supported: 0.2, contradicted: 0.6, not_addressed: 0.2 }, 0.6) },
      ],
      thresholds,
      true,
    );
    expect(result.verdict).toBe("supported");
  });

  it("escalates a claim no piece answered at all", () => {
    const result = verifyTool.mergeClaim("c", [{ piece: piece(1, 60), answer: undefined }], thresholds, true);
    expect(result.verdict).toBe("not_addressed");
    expect(result.gate).toBe("escalate");
    expect(result.confidence).toBe(0);
  });

  it("omits the line range when the caller supplied unsplit inline evidence", () => {
    const result = verifyTool.mergeClaim(
      "c",
      [{ piece: piece(1, 60), answer: answer("supported", { supported: 0.9, contradicted: 0.05, not_addressed: 0.05 }, 0.9) }],
      thresholds,
      false,
    );
    expect(result.where).toBeUndefined();
  });
});

describe("jev_verify chunked end to end", () => {
  it("checks every claim against every piece and merges in code", async () => {
    // A file big enough to split, where the claim is supported only near the
    // end. The budget is ~32k tokens of state, so this needs to be six figures
    // of characters to be a real two-request case rather than a contrived one.
    const lines = Array.from({ length: 1000 }, (_, i) => `filler line ${i + 1} ${"y".repeat(200)}`);
    lines[940] = "The retry budget is five attempts.";
    writeFileSync(join(root, "big.md"), lines.join("\n"));

    const model = new FakeModel((call) => {
      const state = call.state as { evidence: string };
      const supported = state.evidence.includes("retry budget is five");
      const answers: Record<string, Answer> = {};
      for (const id of Object.keys(call.questions)) {
        answers[id] = supported
          ? choice("supported", { supported: 0.96, contradicted: 0.02, not_addressed: 0.02 }, 0.96)
          : choice("not_addressed", { supported: 0.02, contradicted: 0.02, not_addressed: 0.96 }, 0.96);
      }
      return answers;
    });

    const result = await verifyTool.run(
      model,
      { claims: ["The retry budget is five attempts."], evidence_path: "big.md" },
      { ...testConfig, files: { root }, maxConcurrency: 4 },
    );

    expect(result.evidence_chunks).toBeGreaterThan(1);
    expect(model.calls.length).toBe(result.evidence_chunks);
    expect(result.claims[0]!.verdict).toBe("supported");
    expect(result.claims[0]!.where!.start_line).toBeLessThanOrEqual(941);
    expect(result.claims[0]!.where!.end_line).toBeGreaterThanOrEqual(941);
    expect(result.all_supported).toBe(true);
    expect(result.summary.conflicting).toBe(0);
    // Usage is summed across every piece, not just the one that answered.
    expect(result.usage.input_tokens).toBe(100 * result.evidence_chunks);
  });

  it("counts a conflicting claim in the summary and denies all_supported", async () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `filler line ${i + 1} ${"y".repeat(200)}`);
    lines[10] = "Retries are disabled.";
    lines[940] = "Retries are enabled by default.";
    writeFileSync(join(root, "conflict.md"), lines.join("\n"));

    const model = new FakeModel((call) => {
      const state = call.state as { evidence: string };
      const answers: Record<string, Answer> = {};
      const pick = state.evidence.includes("Retries are enabled")
        ? choice("supported", { supported: 0.95, contradicted: 0.03, not_addressed: 0.02 }, 0.95)
        : state.evidence.includes("Retries are disabled.")
          ? choice("contradicted", { supported: 0.02, contradicted: 0.95, not_addressed: 0.03 }, 0.95)
          : choice("not_addressed", { supported: 0.02, contradicted: 0.02, not_addressed: 0.96 }, 0.96);
      for (const id of Object.keys(call.questions)) answers[id] = pick;
      return answers;
    });

    const result = await verifyTool.run(
      model,
      { claims: ["Retries are enabled by default."], evidence_path: "conflict.md" },
      { ...testConfig, files: { root } },
    );

    expect(result.claims[0]!.verdict).toBe("conflicting");
    expect(result.claims[0]!.gate).toBe("escalate");
    expect(result.summary.conflicting).toBe(1);
    expect(result.summary.needs_review).toBe(1);
    expect(result.all_supported).toBe(false);
  });
});
