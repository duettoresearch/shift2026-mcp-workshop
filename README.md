# Agentic Hotel Pricing through MCP + Claude Agent SDK

Workshop stack: a **Duetto-shaped mock RMS**, an **MCP server** that exposes live pricing/demand tools, and a **stateful Claude Agent SDK** agent that decides whether to alert a revenue manager — with human approval on `send_alert`, session resume so the agent does not re-alert, and evals that prove alerts are actionable.

## Quick start

```bash
npm install
cp .env.example .env   # add ANTHROPIC_API_KEY for the agent
```

| Command | What it does |
|---|---|
| `npm start` | MCP over **stdio** (single command — Cursor / Claude / Agent SDK) |
| `npm run mcp:http` | Same tools over Streamable HTTP (`:3848`) |
| `npm run api` | Mock Duetto-like REST API (`:3847`) |
| `npm run agent` | Revenue-manager agent (prompts for `send_alert` approval) |
| `npm run eval` | Deterministic scenario + grader suite |

## Architecture

```
Sim clock + hotel state ──► MCP tools (stdio/HTTP)
        │                      ▲
        ▼                      │
   Mock REST /v1/...     Agent SDK query()
                               │
                     canUseTool → human y/N
                               │
                     Alert ledger (signalId de-dupe)
```

MCP and the mock API share the same in-process engine vocabulary (OTB vs committed, unconstrained demand, BAR, group blocks). Swap `DUETTO_API_BASE` later without renaming tools.

## Cursor MCP config

Add to Cursor MCP settings (or `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "hotel-pricing": {
      "command": "npm",
      "args": ["start"],
      "cwd": "/absolute/path/to/duetto-mcp",
      "env": {
        "SCENARIO": "demand-spike"
      }
    }
  }
}
```

Then ask Cursor: *Review pricing signals for HARBOR-01 and recommend whether to alert.*

`SCENARIO` values: `baseline` | `demand-spike` | `unfilled-block` | `noise`

## MCP tools

**Read (agent auto-allows):**

- `list_hotels` — demo property `HARBOR-01`
- `get_occupancy` — OTB vs committed by stay date
- `get_demand` — unconstrained demand, constrained forecast, pickup, STLY
- `get_rates` — BAR vs recommended BAR
- `list_group_blocks` — contracted / pickup / remaining / wash risk
- `list_signals` — detector output with stable `signalId`
- `list_alerts` — ledger of what already fired

**Write (human gate):**

- `send_alert` — marked `_meta["anthropic/requiresUserInteraction"]=true`; Agent SDK `canUseTool` always prompts. Ledger returns `duplicate_blocked` for the same `signalId`.

Also: resource `hotel://{hotelId}/snapshot` and prompt `review_pricing_signals`.

## Agent loop (workshop path)

```bash
# Terminal A optional — inspect mock API while agent runs
SCENARIO=demand-spike npm run api

# Terminal B — first pass: agent should propose send_alert
SCENARIO=demand-spike npm run agent
# Approve with y when prompted. Note the printed session_id.

# Second pass — same session: should NOT re-alert
SCENARIO=demand-spike npm run agent -- --resume <session_id>
```

De-dupe is two-layer:

1. **Session** — resume keeps prior tool results / reasoning
2. **Ledger** — engine refuses a second `send_alert` for the same `signalId` even on a fresh session

## Mock REST (Duetto-shaped)

```bash
npm run api
curl -s localhost:3847/v1/hotels | jq
curl -s localhost:3847/v1/hotels/HARBOR-01/signals | jq
curl -s -X POST localhost:3847/v1/sim/scenario -H 'content-type: application/json' -d '{"scenario":"demand-spike"}'
curl -s -X POST localhost:3847/v1/sim/tick -H 'content-type: application/json' -d '{"hours":2}'
```

Endpoints mirror ScoreBoard / BlockBuster / Advance vocabulary. Not the partner Open API — that is gated; this mock is swap-ready.

## Evals

```bash
npm run eval
```

| Scenario | Expect |
|---|---|
| `demand-spike` | One alert; recommendation matches rate/BAR/restriction language |
| `unfilled-block` | Alert; wash/cutoff/pickup language |
| `noise-wiggle` | No actionable signal → no alert |
| `resume-same-spike` | Second send blocked as duplicate |
| `fresh-session-same-spike` | Ledger still blocks |

Graders are deterministic (`ACTIONABLE_RECOMMENDATION` regex + ledger status). Live LLM agent runs are optional (`npm run agent`); evals do not require an API key.

## Project layout

```
src/engine/   # clock, hotel state, detectors, alert ledger
src/api/      # mock REST
src/mcp/      # McpServer v2 (registerTool), stdio + HTTP
src/agent/    # Claude Agent SDK runner
src/evals/    # Vitest scenarios + graders
```

## Design notes

- MCP TypeScript SDK **v2** (`@modelcontextprotocol/server`) with `registerTool`, Zod 4 schemas, `structuredContent`, tool annotations.
- Agent SDK permissions: read tools in `allowedTools`; `send_alert` falls through to `canUseTool`.
- `signalId = hash(hotelId|type|stayDates|generation)` — stable across small clock ticks; generation bumps on material severity change.
