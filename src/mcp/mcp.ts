import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  getSharedEngine,
  type PricingEngine,
} from "../engine/index.js";

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

const date_api_schema = z.string()
.optional()
.describe("This is the stay date in the format YYYY-MM-DD");

/**
 * Build an MCP server bound to a pricing engine.
 */
export function createHotelPricingServer(
  engine: PricingEngine = getSharedEngine(),
): McpServer {
  const server = new McpServer({
    name: "hotel-pricing",
    version: "1.0.0",
  });

  server.registerTool("list_hotels", {},
    async () => {
    try {
      return jsonResult({hotels: engine.listHotels()});
    } catch (error) {
      return errorResult(`Something went wrong! Error: ${error}`);
    }
  });

  server.registerTool("list_hotel_rates", {
    inputSchema: z.object({
      hotelId: z.string(),
      from: date_api_schema,
      to: date_api_schema
    }),
    annotations: {readOnlyHint: true}
  },
    async ({hotelId, from, to}) => {
      try {
        return jsonResult({rates: engine.getRates(hotelId, from, to)});
      } catch (error) {
        return errorResult(`Meh! ${error}!`);
      }
    }
  );


  // STEP 1 - let's register a tool to fetch signals
  // ==============================================
  server.registerTool(
    "list_signals",
    {
      inputSchema: z.object({
        hotelId: z.string().optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ hotelId }) =>
      jsonResult({
        now: engine.getNowIso(),
        data: engine.listSignals(hotelId),
      }),
  );


  // STEP 2 - let's register a tools to fetch and send alerts
  // ==============================================
  server.registerTool(
    "list_alerts",
    {
      inputSchema: z.object({
        hotelId: z.string()
      }),
      annotations: { readOnlyHint: true}
    },
    async ({hotelId}) => {
      try {
        return jsonResult({alerts: engine.listAlerts(hotelId)})
      } catch (err) {
        return errorResult(`Having problems! ${err}!`);
      }
    }
  );

  server.registerTool("send_alert",
    {
      inputSchema: z.object({
        hotelId: z.string(),
        signalId: z.string(),
        stayDates: z.array(date_api_schema).describe("List of dates we need to set an alert for"),
        severity: z.enum(["info", "warning", "critical"]),
        recommendation: z.string().describe("What is the recommendation to proceed with after getting the signal"),
        rationale: z.string().describe("why this severity was picked and under what conditions")
      }),
      annotations: { readOnlyHint: false}
    },
    async ({signalId, hotelId, stayDates, severity, recommendation, rationale}) => {
      try {
        const alert = engine.sendAlert({
            signalId, hotelId,
            stayDates: stayDates as string[],
            severity,
            recommendation, rationale
        });

        return jsonResult({alert: alert});
      } catch (error) {
        return errorResult(`Having problems! ${error}!`);
      }
    }
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
  "send_alert",
  "list_signals",
  "list_alerts",
] as const;

export const WRITE_TOOL_NAME = "send_alert";

export const MCP_SERVER_NAME = "hotel-pricing";

export function mcpToolName(tool: string): string {
  return `mcp__${MCP_SERVER_NAME}__${tool}`;
}
