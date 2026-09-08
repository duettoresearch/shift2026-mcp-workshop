/** Deterministic graders for alert quality (no LLM-as-judge). */

export const ACTIONABLE_RECOMMENDATION =
  /rate|BAR|block|wash|cutoff|restriction|pickup|inventory/i;

export function countSendAlerts(
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>,
): number {
  return toolCalls.filter(
    (t) =>
      t.name === "send_alert" ||
      t.name.endsWith("__send_alert") ||
      t.name.includes("send_alert"),
  ).length;
}

export function recommendationsAreActionable(
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>,
): boolean {
  const alerts = toolCalls.filter(
    (t) =>
      t.name === "send_alert" ||
      t.name.endsWith("__send_alert") ||
      t.name.includes("send_alert"),
  );
  if (!alerts.length) return false;
  return alerts.every((a) =>
    ACTIONABLE_RECOMMENDATION.test(String(a.input.recommendation ?? "")),
  );
}
