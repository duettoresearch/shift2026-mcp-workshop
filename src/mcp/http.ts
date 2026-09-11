import express from "express";
import { randomUUID } from "node:crypto";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { isInitializeRequest } from "@modelcontextprotocol/server";
import { createHotelPricingServer } from "./server.js";
import { getSharedEngine } from "../engine/index.js";

async function main() {
  const port = Number(process.env.MCP_HTTP_PORT ?? 3848);
  const engine = getSharedEngine();

  // One transport (+ McpServer) per client session, keyed by mcp-session-id,
  // so multiple hosts/clients can connect concurrently against the same
  // shared in-process engine.
  const transports = new Map<string, NodeStreamableHTTPServerTransport>();

  const app = express();
  app.use(express.json({ limit: "4mb" }));

  app.all("/mcp", async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport = sessionId ? transports.get(sessionId) : undefined;

      if (!transport) {
        if (sessionId) {
          res.status(404).json({ error: "Unknown session" });
          return;
        }
        if (!isInitializeRequest(req.body)) {
          res.status(400).json({ error: "Session required" });
          return;
        }

        transport = new NodeStreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, transport!);
          },
          onsessionclosed: (id) => {
            transports.delete(id);
          },
        });

        const server = createHotelPricingServer(engine);
        await server.connect(transport);
      }

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
