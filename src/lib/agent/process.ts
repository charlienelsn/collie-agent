import { createAdminClient } from "@/lib/supabase/admin";
import type {
  InboundMessage,
  Customer,
  CustomerState,
  OpenRequest,
  AgentDecision,
  InteractionSummary,
  Feedback,
} from "@/lib/types";
import { findCustomer } from "./match-customer";
import { classifyMessage } from "./classify";
import { executeActions } from "./execute";

export interface ProcessResult {
  skipped: boolean;
  reason?: string;
  decision?: AgentDecision;
  feedback?: Feedback;
  matchMethod?: string;
  customerName?: string | null;
}

/**
 * Core agent orchestrator: idempotency → match → classify → execute → log.
 *
 * When isDryRun is true (test harness), skips side effects:
 * - Does NOT create Linear issues
 * - Does NOT update customer state
 * - DOES log with event_type = 'test_classification'
 */
export async function processInboundMessage(
  orgId: string,
  message: InboundMessage,
  isDryRun: boolean = false
): Promise<ProcessResult> {
  const supabase = createAdminClient();

  // 0. Idempotency check
  if (message.source_message_id) {
    const { data: existing } = await supabase
      .from("feedback")
      .select("id")
      .eq("org_id", orgId)
      .eq("source_type", message.source)
      .eq("source_message_id", message.source_message_id)
      .single();

    if (existing) {
      await logAgent(
        orgId,
        "duplicate_skipped",
        null,
        null,
        `Duplicate ${message.source}:${message.source_message_id}`
      );
      return { skipped: true, reason: "duplicate" };
    }
  }

  // 1. Find customer (may be null)
  const { customer, matchMethod } = await findCustomer(orgId, message);

  // 2. Load customer state
  const customerState = customer
    ? await loadCustomerState(customer)
    : null;
  const openRequests = customer
    ? await loadOpenRequests(customer.id)
    : [];

  // 3. AI classification
  const decision = await classifyMessage(message, customerState, openRequests);

  // 4. Skip if no signal
  if (decision.classification === "none") {
    if (customer && !isDryRun) {
      await updateCustomerContext(customer.id, decision.new_interaction_summary);
    }

    const eventType = isDryRun ? "test_classification" : "classification_none";
    await logAgent(
      orgId,
      eventType,
      customer?.id ?? null,
      null,
      decision.reasoning,
      { classification: "none", confidence: decision.confidence }
    );

    return {
      skipped: false,
      decision,
      matchMethod,
      customerName: customer?.name ?? null,
    };
  }

  // 5. Create feedback record (skip in dry-run)
  let feedback: Feedback | null = null;
  if (!isDryRun) {
    const { data, error } = await supabase
      .from("feedback")
      .insert({
        org_id: orgId,
        customer_id: customer?.id ?? null,
        type: decision.classification,
        title: decision.title ?? `${decision.classification} from ${message.source}`,
        detail: decision.detail ?? null,
        urgency: decision.urgency,
        customer_arr: customer?.arr ?? null,
        customer_name: customer?.name ?? message.customer_name ?? null,
        requester_email: message.customer_email ?? null,
        requester_name: message.customer_name ?? null,
        source_type: message.source,
        source_id: message.source_conversation_id ?? null,
        source_message_id: message.source_message_id ?? null,
        source_url: message.source_url ?? null,
        raw_text: message.message_text,
        agent_reasoning: decision.reasoning,
        confidence: decision.confidence,
        status: customer ? "new" : "unmatched",
      })
      .select()
      .single();

    if (error) {
      await logAgent(
        orgId,
        "feedback_insert_error",
        customer?.id ?? null,
        null,
        `Failed to insert feedback: ${error.message}`,
        { error: error.message }
      );
      return {
        skipped: false,
        decision,
        matchMethod,
        customerName: customer?.name ?? null,
      };
    }

    feedback = data as Feedback;
  }

  // 6. Execute actions (only if customer matched and not dry-run)
  if (customer && feedback && !isDryRun) {
    await executeActions(orgId, customer, feedback, decision);
    await updateCustomerState(customer.id, decision);
  }

  // 7. Log
  const eventType = isDryRun ? "test_classification" : "classification_complete";
  await logAgent(
    orgId,
    eventType,
    customer?.id ?? null,
    feedback?.id ?? null,
    `${decision.classification} (${decision.confidence}) — ${decision.reasoning}`,
    {
      classification: decision.classification,
      confidence: decision.confidence,
      urgency: decision.urgency,
      matchMethod,
      actions: decision.actions.map((a) => a.type),
    }
  );

  return {
    skipped: false,
    decision,
    feedback: feedback ?? undefined,
    matchMethod,
    customerName: customer?.name ?? null,
  };
}

/**
 * Build CustomerState from a Customer row + computed fields.
 */
async function loadCustomerState(customer: Customer): Promise<CustomerState> {
  const openRequests = await loadOpenRequests(customer.id);

  let daysUntilRenewal: number | undefined;
  if (customer.renewal_date) {
    const renewalDate = new Date(customer.renewal_date);
    const now = new Date();
    daysUntilRenewal = Math.ceil(
      (renewalDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
    );
  }

  return {
    id: customer.id,
    name: customer.name,
    domain: customer.domain,
    arr: customer.arr ?? undefined,
    mrr: customer.mrr ?? undefined,
    tier: customer.tier ?? undefined,
    renewal_date: customer.renewal_date ?? undefined,
    days_until_renewal: daysUntilRenewal,
    account_owner: customer.account_owner ?? undefined,
    deal_stage: customer.deal_stage ?? undefined,
    sentiment_trend: customer.sentiment_trend,
    interaction_count: customer.interaction_count,
    open_request_count: customer.open_request_count,
    recent_context: (customer.recent_context as InteractionSummary[]) ?? [],
    open_requests: openRequests,
  };
}

/**
 * Load open requests (feedback items with status new/reviewed/accepted and type feature_request or bug).
 */
async function loadOpenRequests(customerId: string): Promise<OpenRequest[]> {
  const supabase = createAdminClient();

  const { data } = await supabase
    .from("feedback")
    .select("id, title, type, created_at, issue_tracker_id, issue_tracker_status")
    .eq("customer_id", customerId)
    .in("type", ["feature_request", "bug"])
    .in("status", ["new", "reviewed", "accepted"])
    .order("created_at", { ascending: false })
    .limit(20);

  if (!data) return [];

  return data.map((row) => ({
    feedback_id: row.id,
    title: row.title,
    type: row.type as "feature_request" | "bug",
    created_at: row.created_at,
    linear_issue_id: row.issue_tracker_id ?? undefined,
    linear_status: row.issue_tracker_status ?? undefined,
  }));
}

/**
 * Update customer's recent_context with new interaction summary.
 * Keeps last 10, newest first.
 */
async function updateCustomerContext(
  customerId: string,
  summary: InteractionSummary
): Promise<void> {
  const supabase = createAdminClient();

  const { data: customer } = await supabase
    .from("customers")
    .select("recent_context, interaction_count")
    .eq("id", customerId)
    .single();

  if (!customer) return;

  const recentContext = Array.isArray(customer.recent_context)
    ? (customer.recent_context as InteractionSummary[])
    : [];

  const updated = [summary, ...recentContext].slice(0, 10);

  await supabase
    .from("customers")
    .update({
      recent_context: updated,
      interaction_count: (customer.interaction_count ?? 0) + 1,
      last_interaction_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", customerId);
}

/**
 * Update customer state based on agent decision (sentiment, open request count).
 */
async function updateCustomerState(
  customerId: string,
  decision: AgentDecision
): Promise<void> {
  const supabase = createAdminClient();

  const updates: Record<string, unknown> = {
    last_interaction_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // Update sentiment if the agent determined a change
  if (decision.sentiment_update) {
    updates.sentiment_trend = decision.sentiment_update;
  }

  // Increment open request count if new issue was requested
  const hasCreateAction = decision.actions.some((a) => a.type === "create_issue");
  if (hasCreateAction && (decision.classification === "feature_request" || decision.classification === "bug")) {
    const { data: customer } = await supabase
      .from("customers")
      .select("open_request_count")
      .eq("id", customerId)
      .single();

    if (customer) {
      updates.open_request_count = (customer.open_request_count ?? 0) + 1;
    }
  }

  // Update context with new interaction
  await updateCustomerContext(customerId, decision.new_interaction_summary);

  await supabase.from("customers").update(updates).eq("id", customerId);
}

/**
 * Log an agent event to the agent_log table.
 */
export async function logAgent(
  orgId: string,
  eventType: string,
  customerId: string | null,
  feedbackId: string | null,
  outputSummary: string,
  details?: Record<string, unknown>
): Promise<void> {
  const supabase = createAdminClient();

  await supabase.from("agent_log").insert({
    org_id: orgId,
    event_type: eventType,
    customer_id: customerId,
    feedback_id: feedbackId,
    output_summary: outputSummary,
    details: details ?? null,
  });
}
