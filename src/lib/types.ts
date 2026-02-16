// ===== INBOUND: What the agent receives =====

export interface InboundMessage {
  // Customer identification — agent uses these to look up CustomerState
  // Matching priority: intercom_company_id → customer_domain → customer_email domain
  customer_domain?: string;
  customer_email?: string;
  customer_name?: string;
  intercom_company_id?: string;

  // The message itself
  message_text: string;
  message_html?: string;
  conversation_summary?: string;

  // Source metadata
  source: InboundSource;
  source_conversation_id?: string;
  source_message_id?: string;
  source_url?: string;

  // Timing
  timestamp: string; // ISO 8601

  // Adapter-specific metadata (agent can ignore, stored for debugging)
  raw_metadata?: Record<string, unknown>;
}

export type InboundSource =
  | "intercom"
  | "zendesk"
  | "freshdesk"
  | "helpscout"
  | "email"
  | "slack"
  | "api"
  | "manual"
  | "test";

// Known freemail domains to skip during domain matching
export const FREEMAIL_DOMAINS = new Set([
  "gmail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "aol.com",
  "icloud.com",
  "mail.com",
  "protonmail.com",
  "zoho.com",
  "yandex.com",
  "live.com",
  "msn.com",
]);

// ===== CUSTOMER STATE: What the agent knows about a customer =====

export interface CustomerState {
  id: string;
  name: string;
  domain: string;

  // Revenue context
  arr?: number;
  mrr?: number;
  tier?: string;
  renewal_date?: string; // ISO date
  days_until_renewal?: number; // computed

  // Relationship context
  account_owner?: string;
  deal_stage?: string;

  // Agent-maintained state
  sentiment_trend: "improving" | "stable" | "declining" | "critical";
  interaction_count: number;
  open_request_count: number;

  // Recent history (agent context window)
  recent_context: InteractionSummary[]; // last 10, newest first

  // Open requests for pattern matching
  open_requests: OpenRequest[];
}

export interface InteractionSummary {
  date: string;
  channel: InboundSource;
  summary: string; // 1-2 sentences
  sentiment: "positive" | "neutral" | "negative";
  signals: SignalType[];
}

export type SignalType =
  | "feature_request"
  | "bug"
  | "churn_risk"
  | "praise"
  | "complaint"
  | "escalation"
  | "competitor_mention";

export interface OpenRequest {
  feedback_id: string;
  title: string;
  type: "feature_request" | "bug";
  created_at: string;
  linear_issue_id?: string;
  linear_status?: string;
}

// ===== AGENT OUTPUT: What the agent decides =====

export interface AgentDecision {
  classification:
    | "feature_request"
    | "bug"
    | "churn_signal"
    | "praise"
    | "complaint"
    | "none";
  confidence: number; // 0.0 to 1.0
  title?: string;
  detail?: string;
  urgency: "critical" | "high" | "normal" | "low";
  actions: AgentAction[];
  sentiment_update?: "improving" | "stable" | "declining" | "critical";
  new_interaction_summary: InteractionSummary;
  reasoning: string;
  related_feedback_id?: string;
}

export type AgentAction =
  | { type: "create_issue"; title: string; detail: string; urgency: string }
  | { type: "escalate_existing"; feedback_id: string; reason: string }
  | { type: "notify_human"; reason: string; urgency: "critical" | "high" }
  | { type: "no_action" };

// ===== CUSTOMER DATA IMPORT =====

export interface CustomerImportRow {
  name: string;
  domain: string;
  arr?: number;
  mrr?: number;
  tier?: string;
  renewal_date?: string; // YYYY-MM-DD
  account_owner?: string;
  hubspot_company_id?: string;
  intercom_company_id?: string;
}

// ===== DATABASE ROW TYPES =====

export interface Organization {
  id: string;
  name: string;
  slug: string;
  api_key: string | null;
  created_at: string;
}

export interface User {
  id: string;
  org_id: string;
  email: string;
  name: string | null;
  role: "owner" | "admin" | "member";
  created_at: string;
}

export interface Customer {
  id: string;
  org_id: string;
  name: string;
  domain: string;
  hubspot_company_id: string | null;
  intercom_company_id: string | null;
  stripe_customer_id: string | null;
  arr: number | null;
  mrr: number | null;
  revenue_source: "hubspot" | "stripe" | "csv" | "manual" | null;
  deal_stage: string | null;
  renewal_date: string | null;
  tier: string | null;
  account_owner: string | null;
  sentiment_trend: "improving" | "stable" | "declining" | "critical";
  last_interaction_at: string | null;
  interaction_count: number;
  open_request_count: number;
  recent_context: InteractionSummary[];
  created_at: string;
  updated_at: string;
}

export interface Feedback {
  id: string;
  org_id: string;
  customer_id: string | null;
  type: "feature_request" | "bug" | "churn_signal" | "praise" | "complaint";
  title: string;
  detail: string | null;
  urgency: "critical" | "high" | "normal" | "low";
  customer_arr: number | null;
  customer_name: string | null;
  requester_email: string | null;
  requester_name: string | null;
  source_type: string;
  source_id: string | null;
  source_message_id: string | null;
  source_url: string | null;
  raw_text: string | null;
  agent_reasoning: string | null;
  confidence: number | null;
  status: "new" | "reviewed" | "accepted" | "rejected" | "merged" | "unmatched";
  reviewed_by: string | null;
  issue_tracker_type: "linear" | "jira" | "shortcut" | null;
  issue_tracker_id: string | null;
  issue_tracker_url: string | null;
  issue_tracker_status: string | null;
  shipped_at: string | null;
  notification_sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentLog {
  id: string;
  org_id: string;
  event_type: string;
  customer_id: string | null;
  feedback_id: string | null;
  input_summary: string | null;
  output_summary: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

export interface Notification {
  id: string;
  org_id: string;
  customer_id: string;
  feedback_id: string;
  trigger_type:
    | "shipped"
    | "in_progress"
    | "stale_request"
    | "customer_followup"
    | "manual";
  subject: string;
  body_html: string;
  body_plain: string;
  to_email: string;
  to_name: string | null;
  status: "draft" | "approved" | "sent" | "failed";
  approved_by: string | null;
  sent_at: string | null;
  created_at: string;
}

export interface Integration {
  id: string;
  org_id: string;
  provider: "hubspot" | "linear" | "intercom" | "zendesk" | "stripe";
  nango_connection_id: string;
  status: "active" | "disconnected" | "error";
  last_sync_at: string | null;
  config: Record<string, unknown>;
  created_at: string;
}

export interface FeedbackStatusHistory {
  id: string;
  feedback_id: string;
  old_status: string | null;
  new_status: string;
  changed_at: string;
}

export interface NotificationTrigger {
  id: string;
  org_id: string;
  trigger_type: "shipped" | "in_progress" | "stale_request";
  enabled: boolean;
  config: Record<string, unknown>;
  created_at: string;
}
