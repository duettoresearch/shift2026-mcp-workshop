import { describe, expect, it, beforeEach } from "vitest";
import { PricingEngine } from "../engine/index.js";
import { createHotelPricingServer } from "../mcp/mcp.js";
import { ACTIONABLE_RECOMMENDATION } from "./graders.js";

describe("PricingEngine scenarios", () => {
  let engine: PricingEngine;

  beforeEach(() => {
    engine = PricingEngine.create({ scenario: "baseline" });
  });

  it("demand-spike emits actionable signal with rate gap", () => {
    engine.setScenario("demand-spike");
    const signals = engine.listSignals();
    const spike = signals.find((s) => s.type === "demand_spike");
    expect(spike).toBeDefined();
    expect(spike!.actionable).toBe(true);
    expect(spike!.estimatedImpactUsd).toBeGreaterThan(100);
    expect(spike!.stayDates.length).toBeGreaterThan(0);

    const rates = engine.getRates(engine.hotel.hotelId);
    const spiked = rates.filter((r) => spike!.stayDates.includes(r.stayDate));
    expect(spiked.some((r) => r.recommendedBar - r.bar >= 30)).toBe(true);
  });

  it("unfilled-block emits wash-risk signal", () => {
    engine.setScenario("unfilled-block");
    const signals = engine.listSignals();
    const block = signals.find((s) => s.type === "unfilled_block");
    expect(block).toBeDefined();
    expect(block!.actionable).toBe(true);
    expect(block!.relatedBlockId).toBe("BLK-TECH-SUMMIT");

    const blocks = engine.listGroupBlocks(engine.hotel.hotelId);
    expect(blocks[0]!.washRisk).toBe(true);
    expect(blocks[0]!.remainingRooms).toBeGreaterThan(0);
  });

  it("noise emits non-actionable signal only", () => {
    engine.setScenario("noise");
    const signals = engine.listSignals();
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s.actionable === false)).toBe(true);
    expect(signals.every((s) => s.type === "noise")).toBe(true);
  });

  it("ledger blocks duplicate send_alert for same signalId", () => {
    engine.setScenario("demand-spike");
    const signal = engine.listSignals().find((s) => s.type === "demand_spike")!;
    const first = engine.sendAlert({
      signalId: signal.signalId,
      hotelId: signal.hotelId,
      stayDates: signal.stayDates,
      severity: signal.severity,
      recommendation: "Raise BAR $40 on spike dates to capture unconstrained demand",
      rationale: "Demand exceeds capacity; recommended BAR already above BAR",
    });
    expect(first.status).toBe("sent");

    const second = engine.sendAlert({
      signalId: signal.signalId,
      hotelId: signal.hotelId,
      stayDates: signal.stayDates,
      severity: signal.severity,
      recommendation: "Raise BAR again",
      rationale: "Same spike",
    });
    expect(second.status).toBe("duplicate_blocked");
    expect(engine.listAlerts().filter((a) => a.status === "sent")).toHaveLength(1);
  });

  it("signalId stays stable across small ticks in same generation", () => {
    engine.setScenario("demand-spike");
    const a = engine.listSignals().find((s) => s.type === "demand_spike")!;
    engine.tick(1);
    const b = engine.listSignals().find((s) => s.type === "demand_spike")!;
    // hour still < 16 so generation stays 1
    expect(engine.getHour()).toBeLessThan(16);
    expect(a.signalId).toBe(b.signalId);
  });
});

describe("MCP server factory", () => {
  it("creates a server with expected tools", () => {
    const engine = PricingEngine.create({ scenario: "demand-spike" });
    const server = createHotelPricingServer(engine);
    expect(server).toBeDefined();
    // Smoke: engine tools work independently of transport
    const signals = engine.listSignals();
    expect(signals.some((s) => s.actionable)).toBe(true);
  });
});

describe("Alert recommendation grader", () => {
  it("accepts rate/block language", () => {
    expect(ACTIONABLE_RECOMMENDATION.test("Raise BAR by $40")).toBe(true);
    expect(ACTIONABLE_RECOMMENDATION.test("Wash remaining block rooms past cutoff")).toBe(
      true,
    );
    expect(ACTIONABLE_RECOMMENDATION.test("hello world")).toBe(false);
  });
});

describe("Eval scenarios (deterministic harness)", () => {
  it("demand-spike: exactly one alert with actionable recommendation", () => {
    const engine = PricingEngine.create({ scenario: "demand-spike" });
    const signal = engine.listSignals().find((s) => s.actionable)!;
    const rec =
      "Increase BAR toward recommended rate and tighten length-of-stay restrictions on spike dates";
    expect(ACTIONABLE_RECOMMENDATION.test(rec)).toBe(true);

    const alert = engine.sendAlert({
      signalId: signal.signalId,
      hotelId: signal.hotelId,
      stayDates: signal.stayDates,
      severity: signal.severity,
      recommendation: rec,
      rationale: signal.summary,
    });
    expect(alert.status).toBe("sent");
    expect(engine.listAlerts().filter((a) => a.status === "sent")).toHaveLength(1);
  });

  it("unfilled-block: alert mentions wash/cutoff/pickup", () => {
    const engine = PricingEngine.create({ scenario: "unfilled-block" });
    const signal = engine.listSignals().find((s) => s.type === "unfilled_block")!;
    const rec =
      "Chase group pickup before wash; if no names by cutoff, release remaining rooms to transient";
    expect(ACTIONABLE_RECOMMENDATION.test(rec)).toBe(true);
    const alert = engine.sendAlert({
      signalId: signal.signalId,
      hotelId: signal.hotelId,
      stayDates: signal.stayDates,
      severity: signal.severity,
      recommendation: rec,
      rationale: signal.summary,
    });
    expect(alert.status).toBe("sent");
  });

  it("noise-wiggle: must not alert", () => {
    const engine = PricingEngine.create({ scenario: "noise" });
    const signals = engine.listSignals();
    const actionable = signals.filter((s) => s.actionable);
    expect(actionable).toHaveLength(0);
    // Harness policy: refuse to send for non-actionable
    for (const s of signals) {
      expect(s.actionable).toBe(false);
    }
    expect(engine.listAlerts()).toHaveLength(0);
  });

  it("resume-same-spike: second pass sees ledger and does not re-send", () => {
    const engine = PricingEngine.create({ scenario: "demand-spike" });
    const signal = engine.listSignals().find((s) => s.type === "demand_spike")!;
    engine.sendAlert({
      signalId: signal.signalId,
      hotelId: signal.hotelId,
      stayDates: signal.stayDates,
      severity: signal.severity,
      recommendation: "Raise BAR $35 on demand spike dates",
      rationale: "Unconstrained demand above capacity",
    });

    // Simulate resumed session: agent checks ledger first
    const prior = engine.listAlerts().filter((a) => a.status === "sent");
    expect(prior.some((a) => a.signalId === signal.signalId)).toBe(true);

    const blocked = engine.sendAlert({
      signalId: signal.signalId,
      hotelId: signal.hotelId,
      stayDates: signal.stayDates,
      severity: signal.severity,
      recommendation: "Raise BAR again",
      rationale: "Would be a duplicate",
    });
    expect(blocked.status).toBe("duplicate_blocked");
    expect(engine.listAlerts().filter((a) => a.status === "sent")).toHaveLength(1);
  });

  it("fresh-session-same-spike: ledger still blocks duplicate", () => {
    // Same engine process = shared ledger (MCP child keeps state within one eval process)
    const engine = PricingEngine.create({ scenario: "demand-spike" });
    const signal = engine.listSignals().find((s) => s.type === "demand_spike")!;
    engine.sendAlert({
      signalId: signal.signalId,
      hotelId: signal.hotelId,
      stayDates: signal.stayDates,
      severity: "critical",
      recommendation: "Raise BAR and apply restriction",
      rationale: "Spike",
    });

    // "Fresh session" still hits same ledger
    expect(engine.hasAlertForSignal(signal.signalId)).toBe(true);
    const again = engine.sendAlert({
      signalId: signal.signalId,
      hotelId: signal.hotelId,
      stayDates: signal.stayDates,
      severity: "critical",
      recommendation: "Raise BAR",
      rationale: "Fresh agent session should still be blocked",
    });
    expect(again.status).toBe("duplicate_blocked");
  });
});
