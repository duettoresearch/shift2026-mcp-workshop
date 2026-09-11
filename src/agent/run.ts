import { query } from "@anthropic-ai/claude-agent-sdk";

async function main() {
  const stream = query({
    prompt: "Please greet our great attendees to the Agent SDK Workshop!",
    options: {
      model: "sonnet"
    },
  });

  // Handle the live stream response from the agent
  for await (const message of stream) {
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

main().catch(console.error);
