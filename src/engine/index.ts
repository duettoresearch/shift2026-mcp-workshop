import { createHash } from "node:crypto";
import type {
  AlertRecord,
  ApiSnapshotDbg,
  DailyDemand,
  DailyOccupancy,
  DailyRates,
  GroupBlock,
  Hotel,
  HotelId,
  PricingSignal,
  ScenarioName,
  SignalSeverity,
  SignalType,
  StayDate,
} from "./types.js";

const HOTEL: Hotel = {
  hotelId: "HARBOR-01",
  name: "Harbor View Boutique",
  currency: "USD",
  capacity: 120,
  timezone: "America/Los_Angeles",
};

function addDays(isoDate: string, days: number): StayDate {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function signalIdFor(
  hotelId: string,
  type: SignalType,
  stayDates: StayDate[],
  generation: number,
): string {
  const raw = `${hotelId}|${type}|${stayDates.join(",")}|g${generation}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

export interface EngineOptions {
  scenario?: ScenarioName;
  /** Fixed "today" for reproducible demos/evals */
  baseDate?: StayDate;
  startHour?: number;
}

/**
 * In-process Duetto-shaped pricing/demand engine.
 * Sim clock ticks hours; scenarios inject spikes, wash risk, or noise.
 */
export class PricingEngine implements PricingEngine {
  readonly hotel: Hotel = { ...HOTEL };
  private hour: number;
  private readonly baseDate: StayDate;
  private scenario: ScenarioName;
  private readonly occupancy = new Map<StayDate, DailyOccupancy>();
  private readonly demand = new Map<StayDate, DailyDemand>();
  private readonly rates = new Map<StayDate, DailyRates>();
  private blocks: GroupBlock[] = [];
  private readonly alerts: AlertRecord[] = [];
  private signalGeneration = new Map<string, number>();

  constructor(options: EngineOptions = {}) {
    this.scenario = options.scenario ?? "baseline";
    this.baseDate = options.baseDate ?? "2026-09-15";
    this.hour = options.startHour ?? 8;
    this.seedBaseline();
    this.applyScenario(this.scenario);
  }

  static create(options?: EngineOptions): PricingEngine {
    return new PricingEngine(options);
  }

  getNowIso(): string {
    return `${this.baseDate}T${String(this.hour).padStart(2, "0")}:00:00`;
  }

  getHour(): number {
    return this.hour;
  }

  getScenario(): ScenarioName {
    return this.scenario;
  }

  listHotels(): Hotel[] {
    return [this.hotel];
  }

  /** Advance simulation by N hours and re-evaluate scenario effects. */
  tick(hours = 1): void {
    this.hour += hours;
    while (this.hour >= 24) {
      this.hour -= 24;
    }
    this.applyScenario(this.scenario);
  }

  setScenario(scenario: ScenarioName): void {
    this.scenario = scenario;
    this.seedBaseline();
    this.applyScenario(scenario);
  }

  reset(scenario?: ScenarioName): void {
    this.alerts.length = 0;
    this.signalGeneration.clear();
    this.hour = 8;
    if (scenario) this.scenario = scenario;
    this.seedBaseline();
    this.applyScenario(this.scenario);
  }

  stayDates(days = 7): StayDate[] {
    return Array.from({ length: days }, (_, i) => addDays(this.baseDate, i));
  }

  getOccupancy(hotelId: HotelId, from?: StayDate, to?: StayDate): DailyOccupancy[] {
    this.assertHotel(hotelId);
    return this.filterByRange([...this.occupancy.values()], from, to);
  }

  getDemand(hotelId: HotelId, from?: StayDate, to?: StayDate): DailyDemand[] {
    this.assertHotel(hotelId);
    return this.filterByRange([...this.demand.values()], from, to);
  }

  getRates(hotelId: HotelId, from?: StayDate, to?: StayDate): DailyRates[] {
    this.assertHotel(hotelId);
    return this.filterByRange([...this.rates.values()], from, to);
  }

  listGroupBlocks(hotelId: HotelId): GroupBlock[] {
    this.assertHotel(hotelId);
    return this.blocks.filter((b) => b.hotelId === hotelId);
  }

  listSignals(hotelId?: HotelId): PricingSignal[] {
    const signals = this.detectSignals();
    return hotelId ? signals.filter((s) => s.hotelId === hotelId) : signals;
  }

  listAlerts(hotelId?: HotelId): AlertRecord[] {
    return hotelId
      ? this.alerts.filter((a) => a.hotelId === hotelId)
      : [...this.alerts];
  }

  hasAlertForSignal(signalId: string): boolean {
    return this.alerts.some(
      (a) => a.signalId === signalId && a.status === "sent",
    );
  }

  sendAlert(input: {
    signalId: string;
    hotelId: HotelId;
    stayDates: StayDate[];
    severity: SignalSeverity;
    recommendation: string;
    rationale: string;
  }): AlertRecord {
    this.assertHotel(input.hotelId);

    if (this.hasAlertForSignal(input.signalId)) {
      const blocked: AlertRecord = {
        alertId: `dup-${input.signalId}`,
        signalId: input.signalId,
        hotelId: input.hotelId,
        stayDates: input.stayDates,
        severity: input.severity,
        recommendation: input.recommendation,
        rationale: input.rationale,
        sentAt: this.getNowIso(),
        status: "duplicate_blocked",
      };
      this.alerts.push(blocked);
      return blocked;
    }

    const signal = this.listSignals(input.hotelId).find(
      (s) => s.signalId === input.signalId,
    );
    if (!signal) {
      throw new Error(`Unknown signalId: ${input.signalId}`);
    }

    const record: AlertRecord = {
      alertId: `alert-${this.alerts.filter((a) => a.status === "sent").length + 1}`,
      signalId: input.signalId,
      hotelId: input.hotelId,
      stayDates: input.stayDates.length ? input.stayDates : signal.stayDates,
      severity: input.severity,
      recommendation: input.recommendation,
      rationale: input.rationale,
      sentAt: this.getNowIso(),
      status: "sent",
    };
    this.alerts.push(record);
    return record;
  }

  snapshot(): ApiSnapshotDbg {
    return {
      now: this.getNowIso(),
      hour: this.hour,
      scenario: this.scenario,
      hotels: this.listHotels(),
      occupancy: this.getOccupancy(this.hotel.hotelId),
      demand: this.getDemand(this.hotel.hotelId),
      rates: this.getRates(this.hotel.hotelId),
      blocks: this.listGroupBlocks(this.hotel.hotelId),
      signals: this.listSignals(this.hotel.hotelId),
      alerts: this.listAlerts(this.hotel.hotelId),
    };
  }

  private assertHotel(hotelId: HotelId): void {
    if (hotelId !== this.hotel.hotelId) {
      throw new Error(`Unknown hotelId: ${hotelId}`);
    }
  }

  private filterByRange<T extends { stayDate: StayDate }>(
    rows: T[],
    from?: StayDate,
    to?: StayDate,
  ): T[] {
    return rows
      .filter((r) => (!from || r.stayDate >= from) && (!to || r.stayDate <= to))
      .sort((a, b) => a.stayDate.localeCompare(b.stayDate));
  }

  private seedBaseline(): void {
    this.occupancy.clear();
    this.demand.clear();
    this.rates.clear();
    const capacity = this.hotel.capacity;
    const dates = this.stayDates(7);

    for (let i = 0; i < dates.length; i++) {
      const stayDate = dates[i]!;
      const otb = 55 + i * 3;
      const blockRemaining = i >= 2 && i <= 4 ? 18 : 0;
      const committed = otb + blockRemaining;
      this.occupancy.set(stayDate, {
        hotelId: this.hotel.hotelId,
        stayDate,
        capacity,
        otbRooms: otb,
        committedRooms: committed,
        otbOccupancy: round1((otb / capacity) * 100),
        committedOccupancy: round1((committed / capacity) * 100),
      });

      const unconstrained = 70 + i * 4;
      this.demand.set(stayDate, {
        hotelId: this.hotel.hotelId,
        stayDate,
        unconstrainedDemand: unconstrained,
        constrainedForecast: Math.min(unconstrained, capacity),
        transientDemand: unconstrained - (blockRemaining > 0 ? 12 : 0),
        groupDemand: blockRemaining > 0 ? 12 : 0,
        pickupVsYesterday: 2 + (i % 3),
        stlyOccupancy: 62 + i,
      });

      this.rates.set(stayDate, {
        hotelId: this.hotel.hotelId,
        stayDate,
        bar: 189 + i * 5,
        recommendedBar: 189 + i * 5,
        lastChangeAt: `${this.baseDate}T06:00:00`,
        lastChangeReason: null,
      });
    }

    this.blocks = [
      {
        hotelId: this.hotel.hotelId,
        blockId: "BLK-TECH-SUMMIT",
        name: "Bay Tech Summit",
        stayDateStart: dates[2]!,
        stayDateEnd: dates[4]!,
        contractedRooms: 18,
        pickedUpRooms: 6,
        remainingRooms: 12,
        cutoffDate: addDays(dates[2]!, -7),
        washRisk: false,
        status: "definite",
      },
    ];
  }

  private applyScenario(scenario: ScenarioName): void {
    const dates = this.stayDates(7);
    const capacity = this.hotel.capacity;

    if (scenario === "demand-spike") {
      // Spike on Wed–Fri (indexes 2–4): demand blows past capacity
      for (const i of [2, 3, 4]) {
        const stayDate = dates[i]!;
        const unconstrained = 145 + this.hour; // grows slightly with clock
        const otb = 78 + Math.floor(this.hour / 4);
        const committed = otb + 12;
        this.occupancy.set(stayDate, {
          hotelId: this.hotel.hotelId,
          stayDate,
          capacity,
          otbRooms: otb,
          committedRooms: committed,
          otbOccupancy: round1((otb / capacity) * 100),
          committedOccupancy: round1((committed / capacity) * 100),
        });
        this.demand.set(stayDate, {
          hotelId: this.hotel.hotelId,
          stayDate,
          unconstrainedDemand: unconstrained,
          constrainedForecast: capacity,
          transientDemand: unconstrained - 12,
          groupDemand: 12,
          pickupVsYesterday: 18 + Math.floor(this.hour / 3),
          stlyOccupancy: 68,
        });
        const bar = 210;
        const recommended = 265 + Math.floor(this.hour / 2);
        this.rates.set(stayDate, {
          hotelId: this.hotel.hotelId,
          stayDate,
          bar,
          recommendedBar: recommended,
          lastChangeAt: this.getNowIso(),
          lastChangeReason: "demand_spike",
        });
      }
    }

    if (scenario === "unfilled-block") {
      const block = this.blocks[0]!;
      // Pickup stalls; wash risk rises as cutoff passes and hour advances
      const pickedUp = clamp(4 + Math.floor(this.hour / 12), 4, 6);
      const remaining = block.contractedRooms - pickedUp;
      this.blocks = [
        {
          ...block,
          pickedUpRooms: pickedUp,
          remainingRooms: remaining,
          washRisk: true,
          status: "definite",
          cutoffDate: addDays(dates[2]!, -3), // cutoff already passed
        },
      ];
      for (const i of [2, 3, 4]) {
        const stayDate = dates[i]!;
        const otb = 52 + pickedUp;
        const committed = otb + remaining;
        this.occupancy.set(stayDate, {
          hotelId: this.hotel.hotelId,
          stayDate,
          capacity,
          otbRooms: otb,
          committedRooms: committed,
          otbOccupancy: round1((otb / capacity) * 100),
          committedOccupancy: round1((committed / capacity) * 100),
        });
        this.demand.set(stayDate, {
          hotelId: this.hotel.hotelId,
          stayDate,
          unconstrainedDemand: 58,
          constrainedForecast: 58,
          transientDemand: 46,
          groupDemand: remaining,
          pickupVsYesterday: 0,
          stlyOccupancy: 71,
        });
      }
    }

    if (scenario === "noise") {
      // Tiny wiggles — not actionable
      for (const stayDate of dates) {
        const occ = this.occupancy.get(stayDate)!;
        const delta = (this.hour % 3) - 1;
        const otb = clamp(occ.otbRooms + delta, 40, capacity);
        this.occupancy.set(stayDate, {
          ...occ,
          otbRooms: otb,
          committedRooms: otb + (occ.committedRooms - occ.otbRooms),
          otbOccupancy: round1((otb / capacity) * 100),
          committedOccupancy: round1(
            ((otb + (occ.committedRooms - occ.otbRooms)) / capacity) * 100,
          ),
        });
        const dem = this.demand.get(stayDate)!;
        this.demand.set(stayDate, {
          ...dem,
          pickupVsYesterday: clamp(dem.pickupVsYesterday + delta * 0.2, -1, 4),
        });
      }
    }
  }

  private detectSignals(): PricingSignal[] {
    const signals: PricingSignal[] = [];
    const hotelId = this.hotel.hotelId;
    const capacity = this.hotel.capacity;
    const now = this.getNowIso();

    // Demand spike: unconstrained demand >> capacity and recommended >> BAR
    const spikeDates = this.stayDates(7).filter((d) => {
      const dem = this.demand.get(d)!;
      const rates = this.rates.get(d)!;
      return (
        dem.unconstrainedDemand >= capacity * 1.1 &&
        rates.recommendedBar - rates.bar >= 30
      );
    });
    if (spikeDates.length) {
      const key = `${hotelId}|demand_spike|${spikeDates[0]}-${spikeDates[spikeDates.length - 1]}`;
      // Bump generation only on material severity change (hour crosses thresholds)
      let gen = this.signalGeneration.get(key) ?? 1;
      const peakDemand = Math.max(
        ...spikeDates.map((d) => this.demand.get(d)!.unconstrainedDemand),
      );
      const impact = Math.round((peakDemand - capacity) * 40);
      if (this.hour >= 16 && gen < 2) {
        gen = 2;
        this.signalGeneration.set(key, gen);
      } else if (!this.signalGeneration.has(key)) {
        this.signalGeneration.set(key, gen);
      }
      const severity: SignalSeverity =
        peakDemand >= capacity * 1.2 ? "critical" : "warning";
      signals.push({
        signalId: signalIdFor(hotelId, "demand_spike", spikeDates, gen),
        hotelId,
        type: "demand_spike",
        severity,
        stayDates: spikeDates,
        title: "Transient demand spike",
        summary: `Unconstrained demand peaks at ${peakDemand} rooms vs capacity ${capacity}. Recommended BAR is materially above current BAR.`,
        estimatedImpactUsd: impact * 10,
        actionable: true,
        detectedAt: now,
        generation: gen,
      });
    }

    // Unfilled / wash-risk block
    for (const block of this.blocks) {
      if (!block.washRisk && block.remainingRooms < 8) continue;
      if (!block.washRisk) continue;
      const stayDates = this.stayDates(7).filter(
        (d) => d >= block.stayDateStart && d <= block.stayDateEnd,
      );
      const key = `${hotelId}|unfilled_block|${block.blockId}`;
      let gen = this.signalGeneration.get(key) ?? 1;
      if (this.hour >= 14 && gen < 2) {
        gen = 2;
        this.signalGeneration.set(key, gen);
      } else if (!this.signalGeneration.has(key)) {
        this.signalGeneration.set(key, gen);
      }
      const severity: SignalSeverity =
        block.remainingRooms >= 10 ? "critical" : "warning";
      const impact = block.remainingRooms * 175;
      signals.push({
        signalId: signalIdFor(hotelId, "unfilled_block", stayDates, gen),
        hotelId,
        type: "unfilled_block",
        severity,
        stayDates,
        title: `Unfilled group block: ${block.name}`,
        summary: `${block.remainingRooms} rooms still unpicked on ${block.blockId} past cutoff ${block.cutoffDate}. Wash risk — chase pickup or release inventory.`,
        estimatedImpactUsd: impact,
        actionable: true,
        detectedAt: now,
        generation: gen,
        relatedBlockId: block.blockId,
      });
    }

    // Noise scenario: emit a non-actionable signal so agent must ignore it
    if (this.scenario === "noise") {
      const stayDates = [this.stayDates(7)[0]!];
      const key = `${hotelId}|noise|wiggle`;
      const gen = this.signalGeneration.get(key) ?? 1;
      this.signalGeneration.set(key, gen);
      signals.push({
        signalId: signalIdFor(hotelId, "noise", stayDates, gen),
        hotelId,
        type: "noise",
        severity: "info",
        stayDates,
        title: "Minor occupancy wiggle",
        summary:
          "OTB moved by 1 room with negligible pickup change. No material revenue impact.",
        estimatedImpactUsd: 25,
        actionable: false,
        detectedAt: now,
        generation: gen,
      });
    }

    return signals;
  }
}

/** Shared singleton for MCP + API processes (separate processes = separate engines). */
let shared: PricingEngine | undefined;

export function getSharedEngine(): PricingEngine {
  if (!shared) {
    const scenario = (process.env.SCENARIO as ScenarioName | undefined) ?? "baseline";
    shared = PricingEngine.create({ scenario });
  }
  return shared;
}

export function resetSharedEngine(options?: EngineOptions): PricingEngine {
  shared = PricingEngine.create(options);
  return shared;
}
