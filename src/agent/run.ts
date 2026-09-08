import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  MCP_SERVER_NAME,
  READ_TOOL_NAMES,
  WRITE_TOOL_NAME,
  mcpToolName,
} from "../mcp/server.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const SYSTEM = `You are a revenue-management copilot for Duetto-style hotel pricing.

Goals:
- Detect actionable pricing opportunities or risks (demand spikes, unfilled/wash-risk group blocks).
- Alert a human revenue manager ONLY when the signal is material and actionable.
- Never re-alert on a signal already in the alert ledger (call list_alerts first).
- Ignore noise / non-actionable occupancy wiggles (actionable=false or tiny $ impact).

When you alert via ${WRITE_TOOL_NAME}:
- Include a concrete recommendation naming rate/BAR move, block wash, cutoff chase, or restriction.
- Cite stay dates, severity, and $ / occupancy rationale.

Hotel for this workshop: HARBOR-01 unless told otherwise.`;

function parseArgs(argv: string[]) {
  const args = { resume: undefined as string | undefined, prompt: undefined as string | undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--resume" && argv[i + 1]) {
      args.resume = argv[++i];
    } else if (a === "--prompt" && argv[i + 1]) {
      args.prompt = argv[++i];
    }
  }
  return args;
}

function isSendAlertTool(toolName: string): boolean {
  return (
    toolName === WRITE_TOOL_NAME ||
    toolName === mcpToolName(WRITE_TOOL_NAME) ||
    toolName.endsWith(`__${WRITE_TOOL_NAME}`)
  );
}

async function promptApproval(
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<"allow" | "deny"> {
  const rl = createInterface({ input, output });
  console.error("\n--- HUMAN APPROVAL REQUIRED ---");
  console.error(`Tool: ${toolName}`);
  console.error(JSON.stringify(toolInput, null, 2));
  const answer = (await rl.question("Approve send_alert? [y/N] ")).trim().toLowerCase();
  rl.close();
  return answer === "y" || answer === "yes" ? "allow" : "deny";
}

export async function runAgent(options: {
  resume?: string;
  prompt?: string;
  /** When set, skip stdin and auto allow/deny send_alert (evals). */
  autoApprove?: boolean;
  cwd?: string;
  /** Extra env for the MCP child process (SCENARIO, etc.). */
  mcpEnv?: Record<string, string>;
} = {}) {
  const prompt =
    options.prompt ??
    [
      "Review pricing signals for HARBOR-01.",
      "Use list_signals and list_alerts, then inspect demand/rates/blocks as needed.",
      "If there is an actionable opportunity or risk that has not already been alerted,",
      "call send_alert with a concrete recommendation. Otherwise explain why you are not alerting.",
    ].join(" ");

  const allowedTools = READ_TOOL_NAMES.map(mcpToolName);

  let sessionId: string | undefined = options.resume;
  const toolCalls: Array<{ name: string; input: Record<string, unknown> }> = [];

  for await (const message of query({
    prompt,
    options: {
      cwd: options.cwd ?? ROOT,
      persistSession: true,
      resume: options.resume,
      systemPrompt: SYSTEM,
      permissionMode: "default",
      allowedTools,
      mcpServers: {
        [MCP_SERVER_NAME]: {
          command: "npm",
          args: ["--prefix", options.cwd ?? ROOT, "start"],
          env: Object.fromEntries(
            Object.entries({ ...process.env, ...options.mcpEnv }).filter(
              (e): e is [string, string] => typeof e[1] === "string",
            ),
          ),
        },
      },
      canUseTool: async (toolName, toolInput) => {
        toolCalls.push({ name: toolName, input: toolInput });
        if (!isSendAlertTool(toolName)) {
          return { behavior: "allow", updatedInput: toolInput };
        }
        if (options.autoApprove === true) {
          console.error(`[agent] auto-approving ${toolName}`);
          return { behavior: "allow", updatedInput: toolInput };
        }
        if (options.autoApprove === false) {
          return {
            behavior: "deny",
            message: "send_alert denied by eval harness",
          };
        }
        const decision = await promptApproval(toolName, toolInput);
        if (decision === "allow") {
          return { behavior: "allow", updatedInput: toolInput };
        }
        return {
          behavior: "deny",
          message: "Revenue manager declined the alert",
        };
      },
    },
  })) {
    if (message.type === "system" && "subtype" in message && message.subtype === "init") {
      sessionId = (message as { session_id?: string }).session_id ?? sessionId;
      if (sessionId) {
        console.error(`[agent] session_id=${sessionId}`);
      }
    }
    if (message.type === "assistant") {
      const content = (message as { message?: { content?: unknown } }).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block &&
            typeof block === "object" &&
            "type" in block &&
            (block as { type: string }).type === "text" &&
            "text" in block
          ) {
            process.stdout.write(String((block as { text: string }).text));
          }
          if (
            block &&
            typeof block === "object" &&
            "type" in block &&
            (block as { type: string }).type === "tool_use"
          ) {
            const b = block as { name: string; input: Record<string, unknown> };
            toolCalls.push({ name: b.name, input: b.input });
          }
        }
      }
    }
    if ("result" in message && typeof (message as { result?: unknown }).result === "string") {
      console.error("\n[agent] result:", (message as { result: string }).result.slice(0, 200));
    }
  }

  console.error(`\n[agent] done. Resume with: npm run agent -- --resume ${sessionId ?? "<session_id>"}`);
  return { sessionId, toolCalls };
}

const isMain =
  process.argv[1]?.endsWith("agent/run.ts") ||
  process.argv[1]?.endsWith("agent/run.js");

if (isMain) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Set ANTHROPIC_API_KEY (see .env.example)");
    process.exit(1);
  }
  const args = parseArgs(process.argv.slice(2));
  runAgent(args).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
