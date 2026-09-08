import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createHotelPricingServer } from "./server.js";
import { getSharedEngine } from "../engine/index.js";

async function main() {
  const engine = getSharedEngine();
  const server = createHotelPricingServer(engine);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the MCP wire
  console.error(
    `[hotel-pricing] MCP stdio ready (scenario=${engine.getScenario()} now=${engine.getNowIso()})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
