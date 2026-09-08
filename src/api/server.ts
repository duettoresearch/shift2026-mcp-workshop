import express from "express";
import { getSharedEngine, type PricingEngine } from "../engine/index.js";
import type { ScenarioName } from "../engine/types.js";

export function createApiApp(engine: PricingEngine = getSharedEngine()) {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      now: engine.getNowIso(),
      scenario: engine.getScenario(),
    });
  });

  app.get("/v1/hotels", (_req, res) => {
    res.json({ hotels: engine.listHotels() });
  });

  app.get("/v1/hotels/:hotelId/occupancy", (req, res) => {
    try {
      const from = typeof req.query.from === "string" ? req.query.from : undefined;
      const to = typeof req.query.to === "string" ? req.query.to : undefined;
      res.json({
        hotelId: req.params.hotelId,
        data: engine.getOccupancy(req.params.hotelId!, from, to),
      });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.get("/v1/hotels/:hotelId/demand", (req, res) => {
    try {
      const from = typeof req.query.from === "string" ? req.query.from : undefined;
      const to = typeof req.query.to === "string" ? req.query.to : undefined;
      res.json({
        hotelId: req.params.hotelId,
        data: engine.getDemand(req.params.hotelId!, from, to),
      });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.get("/v1/hotels/:hotelId/rates", (req, res) => {
    try {
      const from = typeof req.query.from === "string" ? req.query.from : undefined;
      const to = typeof req.query.to === "string" ? req.query.to : undefined;
      res.json({
        hotelId: req.params.hotelId,
        data: engine.getRates(req.params.hotelId!, from, to),
      });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.get("/v1/hotels/:hotelId/blocks", (req, res) => {
    try {
      res.json({
        hotelId: req.params.hotelId,
        data: engine.listGroupBlocks(req.params.hotelId!),
      });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.get("/v1/hotels/:hotelId/signals", (req, res) => {
    try {
      res.json({
        hotelId: req.params.hotelId,
        data: engine.listSignals(req.params.hotelId!),
      });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.get("/v1/hotels/:hotelId/alerts", (req, res) => {
    try {
      res.json({
        hotelId: req.params.hotelId,
        data: engine.listAlerts(req.params.hotelId!),
      });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.get("/v1/hotels/:hotelId/snapshot", (req, res) => {
    try {
      if (req.params.hotelId !== engine.hotel.hotelId) {
        throw new Error(`Unknown hotelId: ${req.params.hotelId}`);
      }
      res.json(engine.snapshot());
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.post("/v1/sim/tick", (req, res) => {
    const hours = Number(req.body?.hours ?? 1);
    engine.tick(Number.isFinite(hours) ? hours : 1);
    res.json({ now: engine.getNowIso(), hour: engine.getHour() });
  });

  app.post("/v1/sim/scenario", (req, res) => {
    const scenario = req.body?.scenario as ScenarioName | undefined;
    if (!scenario) {
      res.status(400).json({ error: "scenario required" });
      return;
    }
    engine.setScenario(scenario);
    res.json({ scenario: engine.getScenario(), now: engine.getNowIso() });
  });

  app.post("/v1/sim/reset", (req, res) => {
    const scenario = req.body?.scenario as ScenarioName | undefined;
    engine.reset(scenario);
    res.json({ scenario: engine.getScenario(), now: engine.getNowIso() });
  });

  return app;
}

const isMain =
  process.argv[1]?.endsWith("api/server.ts") ||
  process.argv[1]?.endsWith("api/server.js");

if (isMain) {
  const port = Number(process.env.API_PORT ?? 3847);
  const app = createApiApp();
  app.listen(port, () => {
    console.error(
      `Duetto-shaped mock API listening on http://localhost:${port}`,
    );
  });
}
