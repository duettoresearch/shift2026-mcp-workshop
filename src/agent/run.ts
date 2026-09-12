import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as readline from "node:readline/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { MCP_SERVER_NAME, mcpToolName, READ_TOOL_NAMES, WRITE_TOOL_NAME } from "../mcp/mcp.js";

// Workshop build-up. Each PHASE block is commented out — uncomment top to
// bottom, in order, to take the agent from "says hello" to "runs a real
// pricing-alert loop with a human approval gate."
//
// Gaps to call out to the room:
//  - The pricing ledger (signals/alerts) lives in the in-memory PricingEngine
//    inside the MCP server child process. PHASE 3 gives the *conversation*
//    durable state via session resume, but if the MCP child process restarts,
//    listAlerts()/hasAlertForSignal() resets — the dedupe guard is only as
//    durable as that process. Fine for a workshop demo, call it out live.
//  - Needs ANTHROPIC_API_KEY (or equivalent) in .env for `query()` to run.
//  - PHASE 4's canUseTool is the ONLY thing that gates send_alert — it only
//    works because send_alert is deliberately left OUT of allowedTools.
//    Putting it in allowedTools auto-approves the call before canUseTool is
//    ever consulted (the SDK warns about this: CLAUDE_SDK_CAN_USE_TOOL_SHADOWED).

const SESSION_FILE = ".agent-session";

async function main() {
  const stream = query({
    prompt:
      "You are acting as hotel Property manager, and have access to PMS MCP." +
      "Check today's pricing signals for our hotel. If there is an actionable " +
      "signal that doesn't already have an alert sent, send one with a clear " +
      "recommendation and rationale. Otherwise say there's nothing to do." +
      "As this is a demo MCP might forgot alerts between the runs. ",
    options: {
      model: "sonnet",

      // ── PHASE 1: give the agent an MCP server + tools to call ──────────
      // Points at the HTTP MCP server (`npm run mcp`), not a spawned stdio
      // child — start that process first, this just connects to it.
      // mcpServers: {
      //   [MCP_SERVER_NAME]: {
      //     type: "http",
      //     url: `http://localhost:${process.env.MCP_HTTP_PORT ?? 3848}/mcp`,
      //   },
      // },

      // ── PHASE 2: restrict which tools it's permitted to execute ────────
      // allowedTools: READ_TOOL_NAMES.map(mcpToolName),
      // permissionMode: "default", // required for canUseTool (PHASE 4) to fire

      // ── PHASE 3: give it state — resume the prior session from disk ────
      // resume: existsSync(SESSION_FILE)
      //   ? readFileSync(SESSION_FILE, "utf-8").trim()
      //   : undefined,

      // ── PHASE 4: human-in-the-loop gate before the write tool fires ────
      // This is the ONLY gate for send_alert: it isn't in allowedTools, so
      // every call reaches canUseTool and gets this explicit confirm —
      // independent of whatever generic MCP tool-permission prompt fired
      // for the read tools above.
      // canUseTool: async (toolName, input) => {
      //   if (toolName !== mcpToolName(WRITE_TOOL_NAME)) {
      //     return { behavior: "allow", updatedInput: input };
      //   }
      //   const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      //   const answer = await rl.question(
      //     `\nAgent wants to ${WRITE_TOOL_NAME}: ${JSON.stringify(input, null, 2)}\nApprove? (y/n) `,
      //   );
      //   rl.close();
      //   return answer.trim().toLowerCase() === "y"
      //     ? { behavior: "allow", updatedInput: input }
      //     : { behavior: "deny", message: "Rejected by human reviewer" };
      // },
    },
  });

  // Handle the live stream response from the agent
  for await (const message of stream) {
    if (message.type === "system" && message.subtype === "init") {
      // PHASE 3: stash the session id so the next run can resume it
      // writeFileSync(SESSION_FILE, message.session_id);
    }

    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if ("text" in block) {
          process.stdout.write(block.text);
        } else if ("name" in block) {
          console.log(`\n[Agent executing tool: ${block.name}]`);
        }
      }
    }

    if (message.type === "result") {
      console.log(`\n\nExecution finished: ${message.subtype}`);
    }
  }
}

// ── PHASE 4 (loop): run the check on an interval instead of once ─────────
// while (true) {
//   await main();
//   await new Promise((resolve) => setTimeout(resolve, 10_000));
// }

main().catch(console.error);
