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
