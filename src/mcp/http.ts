import express from "express";
import { randomUUID } from "node:crypto";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { createHotelPricingServer } from "./server.js";
import { getSharedEngine } from "../engine/index.js";

async function main() {
  const port = Number(process.env.MCP_HTTP_PORT ?? 3848);
  const engine = getSharedEngine();
  const server = createHotelPricingServer(engine);
  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await server.connect(transport);

  const app = express();
  app.use(express.json({ limit: "4mb" }));

  app.all("/mcp", async (req, res) => {
    try {
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP HTTP error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal Server Error" });
      }
    }
  });

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      scenario: engine.getScenario(),
      now: engine.getNowIso(),
    });
  });

  app.listen(port, () => {
    console.error(
      `[hotel-pricing] MCP Streamable HTTP http://localhost:${port}/mcp (scenario=${engine.getScenario()})`,
    );
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
