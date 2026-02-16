import Anthropic from "@anthropic-ai/sdk";
import { AI_MODELS } from "@/lib/config";
import type {
  InboundMessage,
  CustomerState,
  OpenRequest,
  AgentDecision,
} from "@/lib/types";

const systemPrompt = `You are the Collie agent. You analyze customer support messages in context of their account history to detect actionable signals.

You receive:
- A customer message from a support channel
- Their account state (if known): ARR, renewal, tier, sentiment trajectory
- Their recent interactions (last 10)
- Their open feature requests/bugs
- If account state is unknown (unmatched), classify from the message alone

CLASSIFICATION (pick primary signal):
- feature_request: Asking for new functionality
- bug: Reporting something broken
- churn_signal: Frustration, competitor mentions, "considering alternatives"
- praise: Expressing satisfaction
- complaint: Unhappy about process/timeline, not a specific bug/feature
- none: Normal support, greeting, logistics — no signal

URGENCY (consider full context):
- critical: High ARR (>$50K) + negative + renewal <90 days, OR explicit churn threat
- high: High ARR + negative, OR repeated escalation
- normal: Standard request
- low: Low ARR + non-urgent + first mention
- Unknown customer → default "normal" unless explicitly urgent

PATTERN DETECTION:
- Same issue mentioned before? → escalation, not new request
- Sentiment declining across interactions?
- Open requests stale while renewal approaches?
- Competitor mentioned by name?

ACTIONS:
- create_issue: New request/bug → tracked issue
- escalate_existing: Existing request escalated — reference feedback_id
- notify_human: Needs human attention (churn, angry high-value)
- no_action: Just update context

Respond in JSON only. Do not include any text outside the JSON object:
{
  "classification": "feature_request|bug|churn_signal|praise|complaint|none",
  "confidence": 0.0-1.0,
  "title": "Short summary (null if none)",
  "detail": "1-2 sentences with context (null if none)",
  "urgency": "critical|high|normal|low",
  "actions": [{ "type": "create_issue|escalate_existing|notify_human|no_action", ...additional fields depending on type }],
  "sentiment_update": "improving|stable|declining|critical",
  "reasoning": "2-3 sentences explaining classification",
  "related_feedback_id": "UUID if escalating, else null",
  "new_interaction_summary": {
    "summary": "1-2 sentence summary",
    "sentiment": "positive|neutral|negative",
    "signals": ["feature_request", "bug", "churn_risk", "praise", "complaint", "escalation", "competitor_mention"]
  }
}

For create_issue actions, include: { "type": "create_issue", "title": "...", "detail": "...", "urgency": "critical|high|normal|low" }
For escalate_existing actions, include: { "type": "escalate_existing", "feedback_id": "UUID", "reason": "..." }
For notify_human actions, include: { "type": "notify_human", "reason": "...", "urgency": "critical|high" }
For no_action: { "type": "no_action" }`;

function buildUserMessage(
  message: InboundMessage,
  customerState: CustomerState | null,
  openRequests: OpenRequest[]
): string {
  if (customerState) {
    const recentContext =
      customerState.recent_context
        .map(
          (c) =>
            `[${c.date}] ${c.channel}: ${c.summary} (${c.sentiment})`
        )
        .join("\n") || "None";

    const openRequestsList =
      openRequests
        .map((r) => `- ${r.title} (created ${r.created_at})${r.linear_status ? ` [${r.linear_status}]` : ""}`)
        .join("\n") || "None";

    return `CUSTOMER: ${customerState.name} (${customerState.domain})
ARR: $${customerState.arr ?? "unknown"} | Tier: ${customerState.tier ?? "unknown"} | Renewal: ${customerState.renewal_date ?? "unknown"}${customerState.days_until_renewal != null ? ` (${customerState.days_until_renewal} days)` : ""}
Sentiment: ${customerState.sentiment_trend} | Open Requests: ${customerState.open_request_count}

RECENT INTERACTIONS:
${recentContext}

OPEN REQUESTS:
${openRequestsList}

NEW MESSAGE (${message.source}):
${message.message_text}`;
  }

  return `CUSTOMER: Unknown (unmatched)
Email: ${message.customer_email ?? "unknown"} | Domain: ${message.customer_domain ?? "unknown"}

NEW MESSAGE (${message.source}):
${message.message_text}`;
}

export async function classifyMessage(
  message: InboundMessage,
  customerState: CustomerState | null,
  openRequests: OpenRequest[]
): Promise<AgentDecision> {
  const anthropic = new Anthropic();

  const userMessage = buildUserMessage(message, customerState, openRequests);

  const response = await anthropic.messages.create({
    model: AI_MODELS.classification,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  // Parse JSON response, stripping markdown code fences if present
  let jsonText = text.trim();
  if (jsonText.startsWith("```")) {
    jsonText = jsonText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  try {
    const parsed = JSON.parse(jsonText) as AgentDecision;

    // Ensure required fields have valid defaults
    if (!parsed.new_interaction_summary) {
      parsed.new_interaction_summary = {
        date: new Date().toISOString().split("T")[0],
        channel: message.source,
        summary: message.message_text.substring(0, 200),
        sentiment: "neutral",
        signals: [],
      };
    } else {
      // Ensure date and channel are present
      parsed.new_interaction_summary.date =
        parsed.new_interaction_summary.date || new Date().toISOString().split("T")[0];
      parsed.new_interaction_summary.channel =
        parsed.new_interaction_summary.channel || message.source;
    }

    // Clamp confidence to valid range
    if (typeof parsed.confidence !== "number" || isNaN(parsed.confidence)) {
      parsed.confidence = 0.5;
    }
    parsed.confidence = Math.max(0, Math.min(1, parsed.confidence));

    // Default actions if missing
    if (!Array.isArray(parsed.actions)) {
      parsed.actions = [{ type: "no_action" }];
    }

    return parsed;
  } catch (e) {
    // If AI returns unparseable JSON, return a safe fallback
    return {
      classification: "none",
      confidence: 0,
      urgency: "normal",
      actions: [{ type: "no_action" }],
      reasoning: `Failed to parse AI response: ${e instanceof Error ? e.message : "Unknown error"}. Raw: ${jsonText.substring(0, 200)}`,
      new_interaction_summary: {
        date: new Date().toISOString().split("T")[0],
        channel: message.source,
        summary: message.message_text.substring(0, 200),
        sentiment: "neutral",
        signals: [],
      },
    };
  }
}
