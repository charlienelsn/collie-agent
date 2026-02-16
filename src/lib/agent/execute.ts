import { createAdminClient } from "@/lib/supabase/admin";
import { CONFIDENCE_THRESHOLD } from "@/lib/config";
import type { Customer, Feedback, AgentDecision } from "@/lib/types";
import { logAgent } from "./process";

/**
 * Execute agent-decided actions. Only called when a customer is matched.
 * Phase 2: Linear issue creation is stubbed (logs intent, no API call).
 */
export async function executeActions(
  orgId: string,
  customer: Customer,
  feedback: Feedback,
  decision: AgentDecision
): Promise<void> {
  const supabase = createAdminClient();

  for (const action of decision.actions) {
    switch (action.type) {
      case "create_issue": {
        // Check confidence threshold
        if (decision.confidence < CONFIDENCE_THRESHOLD) {
          await logAgent(
            orgId,
            "below_threshold",
            customer.id,
            feedback.id,
            `Confidence ${decision.confidence} below threshold ${CONFIDENCE_THRESHOLD}`,
            { confidence: decision.confidence, threshold: CONFIDENCE_THRESHOLD }
          );
          break;
        }

        // Phase 2 stub: log the intent but don't call Linear API
        const issueTitle = `[${customer.name} — $${customer.arr ?? "?"}] ${action.title}`;
        const issueDescription = [
          action.detail,
          "",
          "---",
          `**Customer:** ${customer.name} (${customer.domain})`,
          `**ARR:** $${customer.arr ?? "unknown"}`,
          `**Renewal:** ${customer.renewal_date ?? "unknown"}`,
          `**Sentiment:** ${customer.sentiment_trend}`,
          `**Source:** ${feedback.source_type}${feedback.source_url ? ` — [link](${feedback.source_url})` : ""}`,
          `**Agent reasoning:** ${decision.reasoning}`,
        ].join("\n");

        // Log that we would create an issue (stub)
        await logAgent(
          orgId,
          "linear_issue_stub",
          customer.id,
          feedback.id,
          `Would create Linear issue: ${issueTitle}`,
          {
            title: issueTitle,
            description: issueDescription,
            urgency: action.urgency,
          }
        );

        // Update feedback to show issue was requested (no actual tracker ID yet)
        await supabase
          .from("feedback")
          .update({
            issue_tracker_type: "linear" as const,
            issue_tracker_status: "stub_pending",
            updated_at: new Date().toISOString(),
          })
          .eq("id", feedback.id);

        break;
      }

      case "notify_human": {
        await logAgent(
          orgId,
          "human_notified",
          customer.id,
          feedback.id,
          `Human notification: ${action.reason}`,
          { reason: action.reason, urgency: action.urgency }
        );
        break;
      }

      case "escalate_existing": {
        if (action.feedback_id) {
          // Update the existing feedback urgency
          await supabase
            .from("feedback")
            .update({
              urgency: "high" as const,
              updated_at: new Date().toISOString(),
            })
            .eq("id", action.feedback_id);

          await logAgent(
            orgId,
            "feedback_escalated",
            customer.id,
            feedback.id,
            `Escalated existing feedback ${action.feedback_id}: ${action.reason}`,
            {
              escalated_feedback_id: action.feedback_id,
              reason: action.reason,
            }
          );
        }
        break;
      }

      case "no_action":
        break;
    }
  }
}
