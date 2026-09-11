/** Duetto-shaped domain types for the simulated RMS. */

export type HotelId = string;

export type StayDate = string; // YYYY-MM-DD

export type SignalType = "demand_spike" | "unfilled_block" | "noise";

export type SignalSeverity = "info" | "warning" | "critical";

export interface Hotel {
  hotelId: HotelId;
  name: string;
  currency: string;
  capacity: number;
  timezone: string;
}

export interface DailyOccupancy {
  hotelId: HotelId;
  stayDate: StayDate;
  capacity: number;
  /** Individual reservations + picked-up group rooms */
  otbRooms: number;
  /** OTB + remaining (unpicked) group block rooms */
  committedRooms: number;
  otbOccupancy: number;
  committedOccupancy: number;
}

export interface DailyDemand {
  hotelId: HotelId;
  stayDate: StayDate;
  /** Can exceed capacity (unconstrained) */
  unconstrainedDemand: number;
  /** Capped at capacity */
  constrainedForecast: number;
  transientDemand: number;
  groupDemand: number;
  pickupVsYesterday: number;
  stlyOccupancy: number;
}

export interface DailyRates {
  hotelId: HotelId;
  stayDate: StayDate;
  bar: number;
  recommendedBar: number;
  lastChangeAt: string;
  lastChangeReason: string | null;
}

export interface GroupBlock {
  hotelId: HotelId;
  blockId: string;
  name: string;
  stayDateStart: StayDate;
  stayDateEnd: StayDate;
  contractedRooms: number;
  pickedUpRooms: number;
  remainingRooms: number;
  cutoffDate: StayDate;
  washRisk: boolean;
  status: "definite" | "tentative" | "washed";
}

export interface PricingSignal {
  signalId: string;
  hotelId: HotelId;
  type: SignalType;
  severity: SignalSeverity;
  stayDates: StayDate[];
  title: string;
  summary: string;
  /** Material $ / risk impact estimate for graders + agent */
  estimatedImpactUsd: number;
  actionable: boolean;
  detectedAt: string;
  generation: number;
  relatedBlockId?: string;
}

export interface AlertRecord {
  alertId: string;
  signalId: string;
  hotelId: HotelId;
  stayDates: StayDate[];
  severity: SignalSeverity;
  recommendation: string;
  rationale: string;
  sentAt: string;
  status: "sent" | "duplicate_blocked";
}

export interface ApiSnapshotDbg {
  now: string;
  hour: number;
  scenario: ScenarioName;
  hotels: Hotel[];
  occupancy: DailyOccupancy[];
  demand: DailyDemand[];
  rates: DailyRates[];
  blocks: GroupBlock[];
  signals: PricingSignal[];
  alerts: AlertRecord[];
}

export interface PricingEngine {
  getNowIso(): string;
  getHour(): number;
  getScenario(): ScenarioName;
  listHotels(): Hotel[];
  tick(hours: number): void;

  setScenario(scenario: ScenarioName): void;

  reset(scenario?: ScenarioName): void;

  stayDates(days: number): StayDate[] ;

  getOccupancy(hotelId: HotelId, from?: StayDate, to?: StayDate): DailyOccupancy[];

  getDemand(hotelId: HotelId, from?: StayDate, to?: StayDate): DailyDemand[];

  getRates(hotelId: HotelId, from?: StayDate, to?: StayDate): DailyRates[] ;

  listGroupBlocks(hotelId: HotelId): GroupBlock[];

  listSignals(hotelId?: HotelId): PricingSignal[];

  listAlerts(hotelId?: HotelId): AlertRecord[];

  hasAlertForSignal(signalId: string): boolean ;

  sendAlert(input: {
    signalId: string;
    hotelId: HotelId;
    stayDates: StayDate[];
    severity: SignalSeverity;
    recommendation: string;
    rationale: string;
  }): AlertRecord;

  snapshot(): ApiSnapshotDbg;
}

export const SCENARIO_NAMES = ["baseline", "demand-spike", "unfilled-block", "noise"];
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

export interface EngineSnapshot {
  now: string;
  hour: number;
  scenario: ScenarioName;
  hotels: Hotel[];
}
