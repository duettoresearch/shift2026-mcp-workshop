import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  getSharedEngine,
  type PricingEngine,
} from "../engine/index.js";
import { SCENARIO_NAMES, type ScenarioName, type SignalSeverity } from "../engine/types.js";

function jsonResult<T extends Record<string, unknown>>(data: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

const hotelIdSchema = z.string().describe("Hotel ID, e.g. HARBOR-01");
const dateSchema = z
  .string()
  .optional()
  .describe("Stay date YYYY-MM-DD (inclusive)");

/**
 * Build an MCP server bound to a pricing engine.
 * Factory pattern so stdio/HTTP each get a clean instance when needed.
 */
export function createHotelPricingServer(
  engine: PricingEngine = getSharedEngine(),
): McpServer {
  const server = new McpServer({
    name: "hotel-pricing",
    version: "1.0.0",
  });

  server.registerTool(
    "list_hotels",
    {
      title: "List hotels",
      description: "List hotels available in the simulated Duetto RMS.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => jsonResult({ hotels: engine.listHotels() }),
  );

  server.registerTool(
    "get_occupancy",
    {
      title: "Get occupancy",
      description:
        "OTB vs committed occupancy by stay date (Duetto ScoreBoard-shaped).",
      inputSchema: z.object({
        hotelId: hotelIdSchema,
        from: dateSchema,
        to: dateSchema,
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ hotelId, from, to }) => {
      try {
        return jsonResult({
          hotelId,
          data: engine.getOccupancy(hotelId, from, to),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

  server.registerTool(
    "get_demand",
    {
      title: "Get demand",
      description:
        "Unconstrained demand, constrained forecast, pickup, and STLY by stay date.",
      inputSchema: z.object({
        hotelId: hotelIdSchema,
        from: dateSchema,
        to: dateSchema,
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ hotelId, from, to }) => {
      try {
        return jsonResult({
          hotelId,
          data: engine.getDemand(hotelId, from, to),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

  server.registerTool(
    "get_rates",
    {
      title: "Get rates",
      description: "Current BAR, recommended BAR, and last rate change by stay date.",
      inputSchema: z.object({
        hotelId: hotelIdSchema,
        from: dateSchema,
        to: dateSchema,
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ hotelId, from, to }) => {
      try {
        return jsonResult({
          hotelId,
          data: engine.getRates(hotelId, from, to),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

  server.registerTool(
    "list_group_blocks",
    {
      title: "List group blocks",
      description:
        "Group blocks with contracted/pickup/remaining rooms and wash risk (BlockBuster-shaped).",
      inputSchema: z.object({ hotelId: hotelIdSchema }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ hotelId }) => {
      try {
        return jsonResult({
          hotelId,
          data: engine.listGroupBlocks(hotelId),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

  server.registerTool(
    "list_signals",
    {
      title: "List pricing signals",
      description:
        "Detected pricing opportunities/risks with stable signalId. Prefer actionable=true signals only when alerting.",
      inputSchema: z.object({
        hotelId: hotelIdSchema.optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ hotelId }) =>
      jsonResult({
        now: engine.getNowIso(),
        scenario: engine.getScenario(),
        data: engine.listSignals(hotelId),
      }),
  );

  server.registerTool(
    "list_alerts",
    {
      title: "List sent alerts",
      description:
        "Alert ledger for this engine. Use before send_alert to avoid duplicate notifications.",
      inputSchema: z.object({
        hotelId: hotelIdSchema.optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ hotelId }) =>
      jsonResult({ data: engine.listAlerts(hotelId) }),
  );

  server.registerTool(
    "reset_state",
    {
      title: "Reset the mocked API state",
      description:
        "Resetting the mocked API state in order to test the prompt again.",
      inputSchema: z.object({
        scenario: z.string()
      .refine(
        (val): val is ScenarioName => SCENARIO_NAMES.includes(val as ScenarioName),
        { message: `Must be one of: ${SCENARIO_NAMES.join(", ")}` }
      )
      .describe(`The scenario name to execute. Must be one of: ${SCENARIO_NAMES.join(", ")}`)
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ scenario }) =>
      jsonResult({ data: engine.reset(scenario) }),
  );

  server.registerTool(
    "send_alert",
    {
      title: "Send revenue manager alert",
      description:
        "Send an actionable alert to the revenue manager. Requires human approval. Duplicate signalId alerts are blocked by the ledger.",
      inputSchema: z.object({
        signalId: z.string().describe("Stable signal id from list_signals"),
        hotelId: hotelIdSchema,
        stayDates: z
          .array(z.string())
          .describe("Affected stay dates YYYY-MM-DD"),
        severity: z.enum(["info", "warning", "critical"]),
        recommendation: z
          .string()
          .describe(
            "Concrete action: rate move, BAR change, block wash, cutoff chase, restriction, etc.",
          ),
        rationale: z
          .string()
          .describe("Why this is actionable now (demand, $ impact, risk)."),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
      _meta: {
        "anthropic/requiresUserInteraction": true,
      },
    },
    async (input) => {
      try {
        const record = engine.sendAlert({
          signalId: input.signalId,
          hotelId: input.hotelId,
          stayDates: input.stayDates,
          severity: input.severity as SignalSeverity,
          recommendation: input.recommendation,
          rationale: input.rationale,
        });
        return jsonResult({ alert: record });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

  // Live snapshot resource for Cursor / Claude resource browsers
  server.registerResource(
    "hotel-snapshot",
    new ResourceTemplate("hotel://{hotelId}/snapshot", {
      list: async () => ({
        resources: engine.listHotels().map((h) => ({
          uri: `hotel://${h.hotelId}/snapshot`,
          name: `${h.name} snapshot`,
          mimeType: "application/json",
        })),
      }),
    }),
    {
      title: "Hotel live snapshot",
      description: "Live OTB, demand, rates, blocks, signals, and alerts",
      mimeType: "application/json",
    },
    async (uri, vars) => {
      const hotelId = String(vars.hotelId ?? "");
      if (hotelId !== engine.hotel.hotelId) {
        throw new Error(`Unknown hotelId: ${hotelId}`);
      }
      const snap = engine.snapshot();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(snap, null, 2),
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "review_pricing_signals",
    {
      title: "Review pricing signals",
      description:
        "Workshop starter: inspect hotel demand/blocks and decide whether to alert the revenue manager.",
      argsSchema: z.object({
        hotelId: z
          .string()
          .optional()
          .describe("Hotel to review (default HARBOR-01)"),
      }),
    },
    ({ hotelId }) => {
      const id = hotelId ?? engine.hotel.hotelId;
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                `You are a revenue-management copilot for hotel ${id}.`,
                "1. Call list_signals and list_alerts.",
                "2. For any actionable signal, pull get_demand / get_rates / list_group_blocks as needed.",
                "3. Only call send_alert when the opportunity or risk is material and not already alerted.",
                "4. Recommendation must name a concrete action (rate/BAR move, block wash, cutoff chase, restriction).",
                "5. Ignore noise / non-actionable wiggles.",
              ].join("\n"),
            },
          },
        ],
      };
    },
  );

  return server;
}

/** MCP tool names used by the agent allow-list. */
export const READ_TOOL_NAMES = [
  "list_hotels",
  "get_occupancy",
  "get_demand",
  "get_rates",
  "list_group_blocks",
  "list_signals",
  "list_alerts",
] as const;

export const WRITE_TOOL_NAME = "send_alert";

export const MCP_SERVER_NAME = "hotel-pricing";

export function mcpToolName(tool: string): string {
  return `mcp__${MCP_SERVER_NAME}__${tool}`;
}
