import { describe, expect, it } from "vitest";
import type { Answer } from "../../src/decision/types.js";
import * as gateActionTool from "../../src/tools/gate-action.js";
import { FakeModel, noul, score, testConfig } from "../helpers/fake-model.js";

const T = { auto: 0.85, review: 0.6 };

/** Shorthand for the four noul signals. */
function signals(
  destructive: number,
  outward_facing: number,
  in_scope: number,
  credential_exposure: number,
): gateActionTool.GateActionSignals {
  return { destructive, outward_facing, in_scope, credential_exposure };
}

const YES = 0.97;
const NO = 0.02;
const MAYBE = 0.5;

describe("gateActionPolicy truth table", () => {
  // destructive, outward, in_scope, credentials, blast -> decision
  const cases: [number, number, number, number, number, gateActionTool.ActionDecision, string][] = [
    [NO, NO, YES, NO, 0, "allow", "read-only, in scope, nothing else"],
    [NO, NO, YES, NO, 1, "allow", "local reversible edit the user asked for"],
    [NO, NO, YES, NO, 2, "confirm", "wide blast radius alone forces a confirm"],
    [NO, NO, YES, NO, 3, "confirm", "production blast radius"],
    [YES, NO, YES, NO, 1, "confirm", "destructive but in scope"],
    [NO, YES, YES, NO, 1, "confirm", "outward-facing but in scope"],
    [NO, NO, YES, YES, 0, "confirm", "credential exposure alone"],
    [YES, NO, NO, NO, 1, "block", "destructive and out of scope"],
    [NO, YES, NO, NO, 1, "block", "outward-facing and out of scope"],
    [YES, YES, NO, YES, 3, "block", "everything at once"],
    // Out of scope, even with nothing else firing, is now worth a confirm: the
    // action is harmless but it is not what the user asked for, and only the
    // user can say whether that is fine.
    [NO, NO, NO, NO, 0, "confirm", "out of scope, nothing else"],
    [MAYBE, NO, YES, NO, 0, "confirm", "uncertain destructive"],
    [NO, MAYBE, YES, NO, 0, "confirm", "uncertain outward-facing"],
    [NO, NO, MAYBE, NO, 0, "confirm", "uncertain scope"],
    [NO, NO, YES, MAYBE, 0, "confirm", "uncertain credentials"],
    [YES, NO, MAYBE, NO, 1, "confirm", "destructive with uncertain scope does not block"],
    [0.84, NO, YES, NO, 0, "confirm", "just inside the uncertain band"],
    [0.86, NO, NO, NO, 0, "block", "just over the auto threshold, out of scope"],
  ];

  for (const [destructive, outward, inScope, creds, blast, expected, label] of cases) {
    it(`${expected}: ${label}`, () => {
      const result = gateActionTool.gateActionPolicy({
        signals: signals(destructive, outward, inScope, creds),
        blast_radius: blast,
        thresholds: T,
      });
      expect(result.decision).toBe(expected);
      expect(result.reasons.length).toBeGreaterThan(0);
    });
  }

  it("reports the lean of every signal", () => {
    const result = gateActionTool.gateActionPolicy({
      signals: signals(YES, NO, MAYBE, NO),
      blast_radius: 0,
      thresholds: T,
    });
    expect(result.leans).toEqual({
      destructive: "yes",
      outward_facing: "no",
      in_scope: "uncertain",
      credential_exposure: "no",
    });
  });

  it("confirms a scope mismatch on its own, and says so", () => {
    const result = gateActionTool.gateActionPolicy({
      signals: signals(NO, NO, NO, NO),
      blast_radius: 0,
      thresholds: T,
    });
    expect(result.decision).toBe("confirm");
    expect(result.reasons.join(" ")).toContain("does not look like something the user asked for");
  });

  it("explains an allow rather than returning an empty reason list", () => {
    const result = gateActionTool.gateActionPolicy({
      signals: signals(NO, NO, YES, NO),
      blast_radius: 0,
      thresholds: T,
    });
    expect(result.reasons).toEqual(["No risk signal fired and the action is in scope."]);
  });

  it("names the wide blast radius in the reasons", () => {
    const result = gateActionTool.gateActionPolicy({
      signals: signals(NO, NO, YES, NO),
      blast_radius: 2.4,
      thresholds: T,
    });
    expect(result.reasons.join(" ")).toContain("blast radius is wide (2.40 of 3)");
  });

  it("treats a lower auto threshold as a wider certain band", () => {
    const loose = gateActionTool.gateActionPolicy({
      signals: signals(0.2, 0.2, 0.8, 0.2),
      blast_radius: 0,
      thresholds: { auto: 0.75, review: 0.6 },
    });
    expect(loose.decision).toBe("allow");

    const strict = gateActionTool.gateActionPolicy({
      signals: signals(0.2, 0.2, 0.8, 0.2),
      blast_radius: 0,
      thresholds: { auto: 0.95, review: 0.6 },
    });
    expect(strict.decision).toBe("confirm");
  });

  it("uses HIGH_BLAST_RADIUS as the documented cut", () => {
    expect(gateActionTool.HIGH_BLAST_RADIUS).toBe(2);
  });
});

describe("gateActionPolicy options", () => {
  const run = (
    s: gateActionTool.GateActionSignals,
    blast: number,
    options?: gateActionTool.GateActionPolicyOptions,
  ): gateActionTool.GateActionPolicyResult =>
    gateActionTool.gateActionPolicy({ signals: s, blast_radius: blast, thresholds: T, options });

  describe("ignoreScope", () => {
    it("drops in_scope from the confirm rule", () => {
      expect(run(signals(NO, NO, NO, NO), 0).decision).toBe("confirm");
      expect(run(signals(NO, NO, NO, NO), 0, { ignoreScope: true }).decision).toBe("allow");
    });

    it("drops in_scope from the block rule", () => {
      expect(run(signals(YES, NO, NO, NO), 1).decision).toBe("block");
      expect(run(signals(YES, NO, NO, NO), 1, { ignoreScope: true }).decision).toBe("confirm");
    });

    it("drops in_scope from the reasons", () => {
      const reasons = run(signals(NO, NO, NO, NO), 0, { ignoreScope: true }).reasons.join(" ");
      expect(reasons).not.toContain("the user asked for");
      expect(reasons).not.toContain("in scope");
    });

    it("drops an uncertain in_scope too", () => {
      expect(run(signals(NO, NO, MAYBE, NO), 0).decision).toBe("confirm");
      const ignored = run(signals(NO, NO, MAYBE, NO), 0, { ignoreScope: true });
      expect(ignored.decision).toBe("allow");
      expect(ignored.reasons.join(" ")).not.toContain("in scope");
    });

    it("still reports the raw signal and its lean", () => {
      const result = run(signals(NO, NO, NO, NO), 0, { ignoreScope: true });
      expect(result.leans.in_scope).toBe("no");
    });

    it("leaves the other rules alone", () => {
      expect(run(signals(YES, NO, YES, NO), 1, { ignoreScope: true }).decision).toBe("confirm");
      expect(run(signals(NO, NO, YES, YES), 0, { ignoreScope: true }).decision).toBe("confirm");
      expect(run(signals(NO, NO, YES, NO), 2.5, { ignoreScope: true }).decision).toBe("confirm");
    });
  });

  describe('uncertain: "risky-lean"', () => {
    const lean = { uncertain: "risky-lean" } as const;

    it("confirms an uncertain risk signal only when it leans towards risk", () => {
      for (const signal of ["destructive", "outward_facing", "credential_exposure"] as const) {
        const risky = signals(NO, NO, YES, NO);
        risky[signal] = 0.6;
        expect(run(risky, 0, lean).decision, `${signal} 0.6`).toBe("confirm");

        const safe = signals(NO, NO, YES, NO);
        safe[signal] = 0.4;
        expect(run(safe, 0, lean).decision, `${signal} 0.4`).toBe("allow");
      }
    });

    it("reads the uncertain band exactly at a half as risky", () => {
      const at = signals(0.5, NO, YES, NO);
      expect(run(at, 0, lean).decision).toBe("confirm");
    });

    it("inverts the test for in_scope, where low is the risky side", () => {
      expect(run(signals(NO, NO, 0.4, NO), 0, lean).decision).toBe("confirm");
      expect(run(signals(NO, NO, 0.6, NO), 0, lean).decision).toBe("allow");
    });

    it("says nothing about an uncertain signal it decided to ignore", () => {
      expect(run(signals(0.4, NO, YES, NO), 0, lean).reasons.join(" ")).not.toContain("unsure");
      expect(run(signals(0.6, NO, YES, NO), 0, lean).reasons.join(" ")).toContain("unsure");
    });

    it("does not soften any established signal", () => {
      expect(run(signals(YES, NO, YES, NO), 0, lean).decision).toBe("confirm");
      expect(run(signals(YES, NO, NO, NO), 1, lean).decision).toBe("block");
      expect(run(signals(NO, NO, YES, NO), 2, lean).decision).toBe("confirm");
    });

    it("matches the default when every signal is decided", () => {
      const decided = signals(NO, NO, YES, NO);
      expect(run(decided, 0, lean)).toEqual(run(decided, 0));
    });
  });

  it('defaults to uncertain: "confirm", preserving the MCP tool behavior', () => {
    expect(run(signals(0.4, NO, YES, NO), 0).decision).toBe("confirm");
    expect(run(signals(0.4, NO, YES, NO), 0, { uncertain: "confirm" }).decision).toBe("confirm");
  });

  it("combines both options", () => {
    expect(run(signals(0.4, NO, 0.4, NO), 0, { ignoreScope: true, uncertain: "risky-lean" }).decision).toBe("allow");
  });
});

describe("run with policy options", () => {
  const answers = (
    destructive: number,
    outward: number,
    inScope: number,
    creds: number,
    blast: number,
  ): Record<string, Answer> => ({
    destructive: noul(destructive),
    outward_facing: noul(outward),
    in_scope: noul(inScope),
    credential_exposure: noul(creds),
    blast_radius: score(blast, ["none", "local", "shared", "production"], 0.8),
  });

  it("takes the options from the input", async () => {
    const model = new FakeModel(() => answers(NO, NO, NO, NO, 0));
    const withScope = await gateActionTool.run(model, { action: "a", user_request: "r" }, testConfig);
    expect(withScope.decision).toBe("confirm");

    const ignored = await gateActionTool.run(
      model,
      { action: "a", user_request: "(unknown)", policy: { ignoreScope: true } },
      testConfig,
    );
    expect(ignored.decision).toBe("allow");
    expect(ignored.signals.in_scope).toBe(NO);
  });

  it("takes the options from the config when the input has none", async () => {
    const model = new FakeModel(() => answers(NO, NO, NO, NO, 0));
    const result = await gateActionTool.run(model, { action: "a", user_request: "r" }, {
      ...testConfig,
      gatePolicy: { ignoreScope: true },
    });
    expect(result.decision).toBe("allow");
  });

  it("lets the input override the config", async () => {
    const model = new FakeModel(() => answers(NO, NO, NO, NO, 0));
    const result = await gateActionTool.run(
      model,
      { action: "a", user_request: "r", policy: { ignoreScope: false } },
      { ...testConfig, gatePolicy: { ignoreScope: true } },
    );
    expect(result.decision).toBe("confirm");
  });

  it("keeps the options out of the MCP input schema", () => {
    const parsed = gateActionTool.inputSchema.parse({
      action: "a",
      user_request: "r",
      policy: { ignoreScope: true },
    });
    expect(parsed).not.toHaveProperty("policy");
  });
});

describe("jev_gate_action", () => {
  const answers = (
    destructive: number,
    outward: number,
    inScope: number,
    creds: number,
    blast: number,
  ): Record<string, Answer> => ({
    destructive: noul(destructive),
    outward_facing: noul(outward),
    in_scope: noul(inScope),
    credential_exposure: noul(creds),
    blast_radius: score(blast, ["none", "local", "shared", "production"], 0.8),
  });

  it("asks five questions in one request and reports every raw probability", async () => {
    const model = new FakeModel(() => answers(0.96, 0.03, 0.94, 0.01, 1.1));

    const result = await gateActionTool.run(
      model,
      {
        action: "Bash(rm -rf ./build)",
        user_request: "clean the build directory",
      },
      testConfig,
    );

    expect(model.calls).toHaveLength(1);
    expect(Object.keys(model.calls[0]!.questions).sort()).toEqual([
      "blast_radius",
      "credential_exposure",
      "destructive",
      "in_scope",
      "outward_facing",
    ]);
    expect(model.calls[0]!.state).toEqual({
      action: "Bash(rm -rf ./build)",
      user_request: "clean the build directory",
    });

    expect(result.decision).toBe("confirm");
    expect(result.signals).toEqual({
      destructive: 0.96,
      outward_facing: 0.03,
      in_scope: 0.94,
      credential_exposure: 0.01,
    });
    expect(result.blast_radius.score).toBe(1.1);
    expect(result.blast_radius.legend).toEqual({
      "0": "none",
      "1": "local",
      "2": "shared",
      "3": "production",
    });
    expect(result.model).toBe("fake-1.0.0");
    expect(result.usage.input_tokens).toBe(100);
  });

  it("includes optional context in the state only when given", async () => {
    const model = new FakeModel(() => answers(NO, NO, YES, NO, 0));
    await gateActionTool.run(model, { action: "a", user_request: "r" }, testConfig);
    expect(model.calls[0]!.state).toEqual({ action: "a", user_request: "r" });

    await gateActionTool.run(model, { action: "a", user_request: "r", context: "c" }, testConfig);
    expect(model.calls[1]!.state).toEqual({ action: "a", user_request: "r", context: "c" });
  });

  it("blocks an out-of-scope destructive action", async () => {
    const model = new FakeModel(() => answers(0.98, 0.02, 0.03, 0.01, 2.5));
    const result = await gateActionTool.run(
      model,
      { action: "Bash(git push --force origin main)", user_request: "run the tests" },
      testConfig,
    );
    expect(result.decision).toBe("block");
    expect(result.reasons.join(" ")).toContain("does not look like something the user asked for");
  });

  it("treats a missing signal as uncertain, not as safe", async () => {
    const model = new FakeModel(() => ({
      destructive: noul(NO),
      outward_facing: noul(NO),
      in_scope: noul(YES),
      credential_exposure: noul(NO),
    }));
    const result = await gateActionTool.run(model, { action: "a", user_request: "r" }, testConfig);
    // blast_radius missing -> defaults to the high cut -> confirm.
    expect(result.decision).toBe("confirm");
    expect(result.blast_radius.score).toBe(gateActionTool.HIGH_BLAST_RADIUS);
  });

  it("honours a per-call thresholds override", async () => {
    const model = new FakeModel(() => answers(0.8, 0.1, 0.8, 0.1, 0));
    const strict = await gateActionTool.run(model, { action: "a", user_request: "r" }, testConfig);
    expect(strict.decision).toBe("confirm");

    const loose = await gateActionTool.run(
      model,
      { action: "a", user_request: "r", thresholds: { auto: 0.75 } },
      testConfig,
    );
    expect(loose.decision).toBe("confirm");
    expect(loose.signal_leans.destructive).toBe("yes");
    expect(loose.thresholds.auto).toBe(0.75);
  });

  it("says in its description that it is not a security boundary", () => {
    expect(gateActionTool.description).toContain("NOT A SECURITY BOUNDARY");
    expect(gateActionTool.description).toMatch(/adversarial/i);
    expect(gateActionTool.description.length).toBeLessThanOrEqual(1200);
  });

  it("produces output that satisfies its output schema", async () => {
    const model = new FakeModel(() => answers(NO, NO, YES, NO, 0));
    const result = await gateActionTool.run(model, { action: "a", user_request: "r" }, testConfig);
    expect(gateActionTool.outputSchema.safeParse(result).success).toBe(true);
  });

  it("validates its input", () => {
    expect(gateActionTool.inputSchema.safeParse({ action: "", user_request: "r" }).success).toBe(false);
    expect(gateActionTool.inputSchema.safeParse({ action: "a" }).success).toBe(false);
  });
});
