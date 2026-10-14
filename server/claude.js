// Headless Claude Code CLI call with no tools and a JSON-schema-constrained reply.
import { run } from "./jobs.js";

const CLAUDE = process.env.CLAUDE_PATH || "claude";

export async function askClaude(prompt, schema, { model, log } = {}) {
  const args = [
    "-p",
    "--output-format", "json",
    "--tools", "",
    "--no-session-persistence",
    "--json-schema", JSON.stringify(schema),
  ];
  if (model || process.env.CLAUDE_MODEL) args.push("--model", model || process.env.CLAUDE_MODEL);

  const { stdout } = await run(CLAUDE, args, { input: prompt });
  const envelope = JSON.parse(stdout);
  if (envelope.is_error) throw new Error(envelope.result || "Claude returned an error");
  let data = envelope.structured_output;
  if (!data && typeof envelope.result === "string") {
    const m = envelope.result.match(/\{[\s\S]*\}/);
    if (m) data = JSON.parse(m[0]);
  }
  if (!data) throw new Error("Claude returned no structured output");
  if (envelope.total_cost_usd) log?.(`Claude cost: $${envelope.total_cost_usd.toFixed(4)}`);
  return data;
}
