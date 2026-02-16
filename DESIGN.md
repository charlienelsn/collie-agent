# Collie Agent — Claude Code Build Prompt (v3)

---

## How to Use This Document with Claude Code

**DO NOT paste this entire document as a single Claude Code prompt.** It's 850+ lines. Claude Code works best with focused, scoped tasks.

**Instead:**

1. Save this file as `DESIGN.md` in your repo root
2. Give Claude Code one phase at a time:
   - "Read DESIGN.md. Now implement Phase 1 only: set up the Next.js project, run the Supabase schema migration, and build the auth flow. Do not build any integration or agent code yet."
   - "Read DESIGN.md. Now implement Phase 2 only: build the agent core — the processInboundMessage function, AI classification, and action execution. Use the interfaces defined in DESIGN.md. Seed 3 test customers directly in Supabase for testing."
   - etc.
3. Each phase should be a separate Claude Code session or a clearly scoped follow-up
4. When in doubt, tell Claude Code: "Only build what I asked for. Reference DESIGN.md for context but don't implement other phases."

---

## What You're Building

Collie is an AI agent that watches customer interactions, enriches them with revenue data, creates Linear issues when it detects feature requests/bugs/churn signals, monitors those issues through completion, and automatically notifies customers when their requested features ship.

It is NOT a dashboard-first product. It is an always-on background agent with a lightweight web interface for configuration, review, and override.

## Core Architecture Principle: Tool-Agnostic Agent, Tool-Specific Adapters

The agent's brain never touches Intercom, HubSpot, or Linear directly. It consumes normalized data and emits normalized actions. Adapters translate between external tools and the agent's internal format.

```
┌─────────────────────────────────────────────────────────────────┐
│                     COLLIE ARCHITECTURE                          │
│                                                                  │
│  INBOUND ADAPTERS          AGENT CORE           OUTBOUND ACTIONS │
│  ─────────────────         ──────────           ──────────────── │
│                                                                  │
│  ┌──────────────┐     ┌──────────────────┐    ┌──────────────┐  │
│  │  Intercom    │     │                  │    │ Create issue  │  │
│  │  Adapter     │────▶│  Normalized      │───▶│ (via Linear   │  │
│  └──────────────┘     │  InboundMessage  │    │  adapter)     │  │
│                       │       +          │    └──────────────┘  │
│  ┌──────────────┐     │  CustomerState   │                      │
│  │  Zendesk     │────▶│       +          │    ┌──────────────┐  │
│  │  Adapter     │     │  AI Classifier   │───▶│ Send notif   │  │
│  │  (v1.1)      │     │       =          │    │ (via Resend) │  │
│  └──────────────┘     │  AgentDecision   │    └──────────────┘  │
│                       │                  │                      │
│  ┌──────────────┐     └──────────────────┘    ┌──────────────┐  │
│  │  Generic     │            ▲                │ Update state  │  │
│  │  Webhook /   │────────────┘                │ (Supabase)    │  │
│  │  API         │                             └──────────────┘  │
│  └──────────────┘                                               │
│                                                                  │
│  CUSTOMER DATA SOURCES                                          │
│  ─────────────────────                                          │
│  ┌──────────────┐     ┌──────────────────┐                      │
│  │  HubSpot     │────▶│                  │                      │
│  │  Sync        │     │  customers       │                      │
│  └──────────────┘     │  table           │                      │
│                       │  (Supabase)      │                      │
│  ┌──────────────┐     │                  │                      │
│  │  CSV Import  │────▶│  Agent reads     │                      │
│  │  (manual)    │     │  from here,      │                      │
│  └──────────────┘     │  never from      │                      │
│                       │  HubSpot direct  │                      │
│  ┌──────────────┐     │                  │                      │
│  │  Stripe      │────▶│                  │                      │
│  │  (v1.1)      │     │                  │                      │
│  └──────────────┘     └──────────────────┘                      │
│                                                                  │
│  SHIP DETECTION                                                 │
│  ──────────────                                                 │
│  ┌──────────────┐     ┌──────────────────┐                      │
│  │  Linear      │────▶│ Match to feedback│───▶ Queue notif     │
│  │  Webhook     │     │ record, trigger  │                      │
│  └──────────────┘     │ notification gen │                      │
│                       └──────────────────┘                      │
└─────────────────────────────────────────────────────────────────┘
```

## Normalized Interfaces (Define These First)

These types are the contract between adapters and the agent core. The agent only speaks these types. Build these BEFORE any integration code.

```typescript
// ===== INBOUND: What the agent receives =====

interface InboundMessage {
  // Customer identification — agent uses these to look up CustomerState
  // Matching priority: intercom_company_id → customer_domain → customer_email domain
  customer_domain?: string;         // primary match key (may be absent for gmail/hotmail users)
  customer_email?: string;          // fallback: extract domain, skip freemail providers
  customer_name?: string;           // display, not for matching
  intercom_company_id?: string;     // most reliable match if Intercom provides company data

  // The message itself
  message_text: string;             // the actual customer words
  message_html?: string;            // if available, for richer context
  conversation_summary?: string;    // if adapter can summarize the full thread

  // Source metadata
  source: InboundSource;
  source_conversation_id?: string;  // for linking back
  source_message_id?: string;       // for idempotency — prevent duplicate processing
  source_url?: string;              // deep link to original conversation

  // Timing
  timestamp: string;                // ISO 8601

  // Adapter-specific metadata (agent can ignore, stored for debugging)
  raw_metadata?: Record<string, unknown>;
}

type InboundSource =
  | 'intercom'
  | 'zendesk'
  | 'freshdesk'
  | 'helpscout'
  | 'email'
  | 'slack'
  | 'api'          // generic webhook / API submission
  | 'manual'       // manually entered in UI
  | 'test';        // from test harness

// Known freemail domains to skip during domain matching
const FREEMAIL_DOMAINS = [
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
  'aol.com', 'icloud.com', 'mail.com', 'protonmail.com',
  'zoho.com', 'yandex.com', 'live.com', 'msn.com'
];

// ===== CUSTOMER STATE: What the agent knows about a customer =====

interface CustomerState {
  id: string;                       // Supabase customer UUID
  name: string;
  domain: string;

  // Revenue context
  arr?: number;
  mrr?: number;
  tier?: string;
  renewal_date?: string;            // ISO date
  days_until_renewal?: number;      // computed

  // Relationship context
  account_owner?: string;
  deal_stage?: string;

  // Agent-maintained state
  sentiment_trend: 'improving' | 'stable' | 'declining' | 'critical';
  interaction_count: number;
  open_request_count: number;

  // Recent history (agent context window)
  recent_context: InteractionSummary[];  // last 10, newest first

  // Open requests for pattern matching
  open_requests: OpenRequest[];
}

interface InteractionSummary {
  date: string;
  channel: InboundSource;
  summary: string;                  // 1-2 sentences
  sentiment: 'positive' | 'neutral' | 'negative';
  signals: SignalType[];
}

type SignalType =
  | 'feature_request'
  | 'bug'
  | 'churn_risk'
  | 'praise'
  | 'complaint'
  | 'escalation'
  | 'competitor_mention';

interface OpenRequest {
  feedback_id: string;
  title: string;
  type: 'feature_request' | 'bug';
  created_at: string;
  linear_issue_id?: string;
  linear_status?: string;
}

// ===== AGENT OUTPUT: What the agent decides =====

interface AgentDecision {
  classification: 'feature_request' | 'bug' | 'churn_signal' | 'praise' | 'complaint' | 'none';
  confidence: number;               // 0.0 to 1.0
  title?: string;
  detail?: string;
  urgency: 'critical' | 'high' | 'normal' | 'low';
  actions: AgentAction[];
  sentiment_update?: 'improving' | 'stable' | 'declining' | 'critical';
  new_interaction_summary: InteractionSummary;
  reasoning: string;
  related_feedback_id?: string;
}

type AgentAction =
  | { type: 'create_issue'; title: string; detail: string; urgency: string }
  | { type: 'escalate_existing'; feedback_id: string; reason: string }
  | { type: 'notify_human'; reason: string; urgency: 'critical' | 'high' }
  | { type: 'no_action' };

// ===== CUSTOMER DATA IMPORT =====

interface CustomerImportRow {
  name: string;                     // required
  domain: string;                   // required
  arr?: number;
  mrr?: number;
  tier?: string;
  renewal_date?: string;            // YYYY-MM-DD
  account_owner?: string;
  hubspot_company_id?: string;
  intercom_company_id?: string;
}
```

## Tech Stack

| Component | Technology | Why |
|-----------|------------|-----|
| Framework | Next.js 14 (App Router) | API routes for webhooks + lightweight UI |
| Language | TypeScript (strict mode) | Type safety for integration payloads |
| Database | Supabase (Postgres + Edge Functions) | Customer state, agent logs, feedback records |
| Auth | Supabase Auth | Multi-tenant, org-level isolation |
| Integrations | Nango | OAuth management for HubSpot, Linear, Intercom |
| AI (classification) | Claude Haiku via Anthropic API | Fast, cheap per-message classification |
| AI (notifications) | Claude Sonnet 4 via Anthropic API | Customer-facing content needs quality |
| Email delivery | Resend | Transactional emails for customer notifications |
| Hosting | Vercel (Pro plan) | Edge-optimized, 60s function timeout |
| Styling | Tailwind CSS + shadcn/ui | Fast UI development |

**AI model configuration — define as constants, not hardcoded:**

```typescript
// /lib/config.ts
export const AI_MODELS = {
  classification: 'claude-3-5-haiku-latest',   // swap to 'claude-sonnet-4-20250514' if quality insufficient
  notification: 'claude-sonnet-4-20250514',     // always Sonnet for customer-facing content
} as const;
```

## Database Schema (Supabase/Postgres)

```sql
-- Multi-tenant organizations
CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  api_key TEXT UNIQUE,  -- for generic inbound API authentication
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Users within orgs
CREATE TABLE users (
  id UUID PRIMARY KEY REFERENCES auth.users(id),
  org_id UUID REFERENCES organizations(id) NOT NULL,
  email TEXT NOT NULL,
  name TEXT,
  role TEXT DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Integration connections (managed by Nango, tracked here)
CREATE TABLE integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('hubspot', 'linear', 'intercom', 'zendesk', 'stripe')),
  nango_connection_id TEXT NOT NULL,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'disconnected', 'error')),
  last_sync_at TIMESTAMPTZ,
  config JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, provider)
);

-- Customer state (the core of the agent — TOOL-AGNOSTIC)
CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) NOT NULL,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  hubspot_company_id TEXT,
  intercom_company_id TEXT,
  stripe_customer_id TEXT,
  arr DECIMAL(12,2),
  mrr DECIMAL(12,2),
  revenue_source TEXT CHECK (revenue_source IN ('hubspot', 'stripe', 'csv', 'manual')),
  deal_stage TEXT,
  renewal_date DATE,
  tier TEXT,
  account_owner TEXT,
  sentiment_trend TEXT DEFAULT 'stable' CHECK (sentiment_trend IN ('improving', 'stable', 'declining', 'critical')),
  last_interaction_at TIMESTAMPTZ,
  interaction_count INTEGER DEFAULT 0,
  open_request_count INTEGER DEFAULT 0,
  recent_context JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_customers_org ON customers(org_id);
CREATE INDEX idx_customers_domain ON customers(org_id, domain);
CREATE INDEX idx_customers_hubspot ON customers(hubspot_company_id);
CREATE INDEX idx_customers_intercom ON customers(intercom_company_id);

-- Feedback items (extracted by agent)
CREATE TABLE feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) NOT NULL,
  customer_id UUID REFERENCES customers(id),  -- NULLABLE: unmatched feedback has no customer
  type TEXT NOT NULL CHECK (type IN ('feature_request', 'bug', 'churn_signal', 'praise', 'complaint')),
  title TEXT NOT NULL,
  detail TEXT,
  urgency TEXT DEFAULT 'normal' CHECK (urgency IN ('critical', 'high', 'normal', 'low')),
  customer_arr DECIMAL(12,2),
  customer_name TEXT,
  requester_email TEXT,      -- the person who said the thing
  requester_name TEXT,
  source_type TEXT NOT NULL CHECK (source_type IN ('intercom', 'zendesk', 'freshdesk', 'helpscout', 'email', 'slack', 'api', 'manual', 'call_transcript', 'test')),
  source_id TEXT,
  source_message_id TEXT,    -- for idempotency
  source_url TEXT,
  raw_text TEXT,
  agent_reasoning TEXT,
  confidence DECIMAL(3,2),
  status TEXT DEFAULT 'new' CHECK (status IN ('new', 'reviewed', 'accepted', 'rejected', 'merged', 'unmatched')),
  reviewed_by UUID REFERENCES users(id),
  issue_tracker_type TEXT CHECK (issue_tracker_type IN ('linear', 'jira', 'shortcut')),
  issue_tracker_id TEXT,
  issue_tracker_url TEXT,
  issue_tracker_status TEXT,
  shipped_at TIMESTAMPTZ,
  notification_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_feedback_org ON feedback(org_id);
CREATE INDEX idx_feedback_customer ON feedback(customer_id);
CREATE INDEX idx_feedback_status ON feedback(status);
CREATE INDEX idx_feedback_type ON feedback(type);
CREATE INDEX idx_feedback_issue ON feedback(issue_tracker_id);
CREATE INDEX idx_feedback_arr ON feedback(customer_arr DESC NULLS LAST);
-- Idempotency: prevent duplicate processing of same message
CREATE UNIQUE INDEX idx_feedback_dedup ON feedback(org_id, source_type, source_message_id)
  WHERE source_message_id IS NOT NULL;

-- Agent activity log
CREATE TABLE agent_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) NOT NULL,
  event_type TEXT NOT NULL,
  customer_id UUID REFERENCES customers(id),
  feedback_id UUID REFERENCES feedback(id),
  input_summary TEXT,
  output_summary TEXT,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_agent_log_org ON agent_log(org_id);
CREATE INDEX idx_agent_log_created ON agent_log(created_at DESC);

-- Notification queue
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) NOT NULL,
  customer_id UUID REFERENCES customers(id) NOT NULL,
  feedback_id UUID REFERENCES feedback(id) NOT NULL,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  body_plain TEXT NOT NULL,
  to_email TEXT NOT NULL,  -- defaults to requester_email, reviewer can edit
  to_name TEXT,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'sent', 'failed')),
  approved_by UUID REFERENCES users(id),
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

## Customer Matching Logic

```typescript
// /lib/agent/match-customer.ts

const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
  'aol.com', 'icloud.com', 'mail.com', 'protonmail.com',
  'zoho.com', 'yandex.com', 'live.com', 'msn.com'
]);

export async function findCustomer(
  orgId: string,
  message: InboundMessage
): Promise<{ customer: Customer | null; matchMethod: string }> {

  // 1. Intercom company ID (most reliable if available)
  if (message.intercom_company_id) {
    const customer = await supabase
      .from('customers').select('*')
      .eq('org_id', orgId)
      .eq('intercom_company_id', message.intercom_company_id)
      .single();
    if (customer.data) return { customer: customer.data, matchMethod: 'intercom_company_id' };
  }

  // 2. Explicit domain (skip freemail)
  if (message.customer_domain && !FREEMAIL_DOMAINS.has(message.customer_domain)) {
    const customer = await supabase
      .from('customers').select('*')
      .eq('org_id', orgId)
      .eq('domain', message.customer_domain)
      .single();
    if (customer.data) return { customer: customer.data, matchMethod: 'domain' };
  }

  // 3. Extract domain from email (skip freemail)
  if (message.customer_email) {
    const emailDomain = message.customer_email.split('@')[1];
    if (emailDomain && !FREEMAIL_DOMAINS.has(emailDomain)) {
      const customer = await supabase
        .from('customers').select('*')
        .eq('org_id', orgId)
        .eq('domain', emailDomain)
        .single();
      if (customer.data) return { customer: customer.data, matchMethod: 'email_domain' };
    }
  }

  // 4. No match — feedback created as unmatched
  return { customer: null, matchMethod: 'none' };
}
```

## Agent Core

```typescript
// /lib/agent/process.ts

export async function processInboundMessage(orgId: string, message: InboundMessage) {
  // 0. Idempotency check
  if (message.source_message_id) {
    const existing = await supabase.from('feedback').select('id')
      .eq('org_id', orgId)
      .eq('source_type', message.source)
      .eq('source_message_id', message.source_message_id)
      .single();
    if (existing.data) {
      await logAgent(orgId, 'duplicate_skipped', null, null,
        `Duplicate ${message.source_message_id}`);
      return;
    }
  }

  // 1. Find customer (may be null)
  const { customer, matchMethod } = await findCustomer(orgId, message);

  // 2. Load customer state
  const customerState = customer ? await loadCustomerState(customer.id) : null;
  const openRequests = customer ? await loadOpenRequests(customer.id) : [];

  // 3. AI classification
  const decision = await classifyMessage(message, customerState, openRequests);

  // 4. Skip if no signal
  if (decision.classification === 'none') {
    if (customer) {
      await updateCustomerContext(customer.id, decision.new_interaction_summary);
    }
    await logAgent(orgId, 'classification_none', customer?.id, null, decision.reasoning);
    return;
  }

  // 5. Create feedback record
  const feedback = await supabase.from('feedback').insert({
    org_id: orgId,
    customer_id: customer?.id || null,
    type: decision.classification,
    title: decision.title,
    detail: decision.detail,
    urgency: decision.urgency,
    customer_arr: customer?.arr || null,
    customer_name: customer?.name || message.customer_name || null,
    requester_email: message.customer_email,
    requester_name: message.customer_name,
    source_type: message.source,
    source_id: message.source_conversation_id,
    source_message_id: message.source_message_id,
    source_url: message.source_url,
    raw_text: message.message_text,
    agent_reasoning: decision.reasoning,
    confidence: decision.confidence,
    status: customer ? 'new' : 'unmatched',
  }).select().single();

  // 6. Execute actions (only if customer matched — no Linear issues without context)
  if (customer) {
    await executeActions(orgId, customer, feedback.data, decision);
    await updateCustomerState(customer.id, decision);
  }

  // 7. Log
  await logAgent(orgId, 'classification_complete', customer?.id, feedback.data.id,
    `${decision.classification} (${decision.confidence}) — ${decision.reasoning}`);
}
```

**Timeout note:** On Vercel Pro (60s), the full chain completes in 5-15 seconds. If timeouts occur during design partner testing, the upgrade path is: webhook handler writes to an `inbound_queue` table and returns immediately, Vercel Cron processes queue every minute. Don't build this until needed.

## AI Classification Prompt

```typescript
// /lib/agent/classify.ts

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

Respond in JSON only:
{
  "classification": "feature_request|bug|churn_signal|praise|complaint|none",
  "confidence": 0.0-1.0,
  "title": "Short summary (null if none)",
  "detail": "1-2 sentences with context (null if none)",
  "urgency": "critical|high|normal|low",
  "actions": [{ "type": "create_issue|escalate_existing|notify_human|no_action" }],
  "sentiment_update": "improving|stable|declining|critical",
  "reasoning": "2-3 sentences explaining classification",
  "related_feedback_id": "UUID if escalating, else null",
  "new_interaction_summary": {
    "summary": "1-2 sentence summary",
    "sentiment": "positive|neutral|negative",
    "signals": ["feature_request", "bug", "churn_risk", "praise", "complaint", "escalation", "competitor_mention"]
  }
}`;

export async function classifyMessage(
  message: InboundMessage,
  customerState: CustomerState | null,
  openRequests: OpenRequest[]
): Promise<AgentDecision> {
  const anthropic = new Anthropic();

  const userMessage = customerState
    ? `CUSTOMER: ${customerState.name} (${customerState.domain})
ARR: $${customerState.arr || 'unknown'} | Tier: ${customerState.tier || 'unknown'} | Renewal: ${customerState.renewal_date || 'unknown'}
Sentiment: ${customerState.sentiment_trend} | Open Requests: ${customerState.open_request_count}

RECENT INTERACTIONS:
${customerState.recent_context.map(c => `[${c.date}] ${c.channel}: ${c.summary} (${c.sentiment})`).join('\n') || 'None'}

OPEN REQUESTS:
${openRequests.map(r => `- ${r.title} (created ${r.created_at})`).join('\n') || 'None'}

NEW MESSAGE (${message.source}):
${message.message_text}`
    : `CUSTOMER: Unknown (unmatched)
Email: ${message.customer_email || 'unknown'} | Domain: ${message.customer_domain || 'unknown'}

NEW MESSAGE (${message.source}):
${message.message_text}`;

  const response = await anthropic.messages.create({
    model: AI_MODELS.classification,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  return JSON.parse(text) as AgentDecision;
}
```

## Action Execution

```typescript
// /lib/agent/execute.ts

export async function executeActions(
  orgId: string, customer: Customer, feedback: Feedback, decision: AgentDecision
) {
  for (const action of decision.actions) {
    switch (action.type) {
      case 'create_issue': {
        // Check confidence threshold
        if (decision.confidence < (orgConfig.auto_create_threshold || 0.7)) {
          // Below threshold → stays in review queue, no auto-issue
          await logAgent(orgId, 'below_threshold', customer.id, feedback.id,
            `Confidence ${decision.confidence} below threshold`);
          break;
        }

        const integration = await getIntegration(orgId, 'linear');
        if (!integration) break;

        const issue = await createLinearIssue(integration, {
          title: `[${customer.name} — $${customer.arr || '?'}] ${action.title}`,
          description: [
            action.detail, '',
            `---`,
            `**Customer:** ${customer.name} (${customer.domain})`,
            `**ARR:** $${customer.arr || 'unknown'}`,
            `**Renewal:** ${customer.renewal_date || 'unknown'}`,
            `**Sentiment:** ${customer.sentiment_trend}`,
            `**Source:** [${feedback.source_type}](${feedback.source_url})`,
            `**Agent reasoning:** ${decision.reasoning}`,
          ].join('\n'),
          priority: mapUrgencyToLinearPriority(decision.urgency),
        });

        await supabase.from('feedback').update({
          issue_tracker_type: 'linear',
          issue_tracker_id: issue.id,
          issue_tracker_url: issue.url,
          issue_tracker_status: issue.state?.name,
        }).eq('id', feedback.id);

        await logAgent(orgId, 'linear_issue_created', customer.id, feedback.id, issue.url);
        break;
      }

      case 'notify_human': {
        await sendAlertEmail(orgId, customer, action.reason);
        await logAgent(orgId, 'human_notified', customer.id, feedback.id, action.reason);
        break;
      }

      case 'escalate_existing': {
        if (action.feedback_id) {
          await escalateExistingFeedback(action.feedback_id, action.reason);
        }
        await logAgent(orgId, 'feedback_escalated', customer.id, feedback.id, action.reason);
        break;
      }
    }
  }
}
```

## Ship Detection + Notifications

### Linear Webhook

```typescript
// /api/webhooks/linear/route.ts
// When issue moves to Done/Shipped:
// 1. Verify signature
// 2. Check if status is in org's shipped_statuses config
// 3. Find feedback records linked via issue_tracker_id
// 4. For each: set shipped_at, generate notification draft
// 5. Notification defaults to_email = feedback.requester_email
//    Reviewer can change before approving
```

### Notification Generation

```typescript
const notificationSystemPrompt = `Write a short, warm email telling a customer their requested feature shipped.

Rules:
- 3-5 sentences max
- Reference their specific request
- Gratitude for feedback
- Clear CTA (try it out, changelog link)
- Human tone, not corporate marketing
- Never use: "We're excited", "We're thrilled", "We value your feedback"

Return JSON only:
{ "subject": "...", "body_html": "...", "body_plain": "..." }`;

// Default to_email: feedback.requester_email (the person who wrote to support)
// Reviewer can change in the notification queue UI before approving
```

## Test Harness

Build this in Phase 2 alongside the agent brain. It's your development testing tool AND your sales demo.

```
/app/(dashboard)/test/page.tsx

┌─────────────────────────────────────────────────────┐
│  Test Collie Agent                                   │
│                                                      │
│  Customer: [▼ Select customer or "Unknown"]          │
│                                                      │
│  Message:                                            │
│  ┌─────────────────────────────────────────────────┐ │
│  │ Hey, we really need bulk export for our team.   │ │
│  │ We've been asking about this for months and     │ │
│  │ honestly we're starting to look at competitors. │ │
│  └─────────────────────────────────────────────────┘ │
│                                                      │
│  Source: [intercom ▼]                                │
│                                                      │
│  [Run Agent]                                         │
│                                                      │
│  ── Agent Decision ──────────────────────────────── │
│  Classification: churn_signal (0.91)                │
│  Urgency: high                                       │
│  Title: "Bulk export needed — competitor evaluation" │
│  Actions: create_issue, notify_human                │
│  Sentiment: declining                                │
│  Reasoning: "Customer has mentioned bulk export in  │
│  2 previous interactions. Combined with competitor  │
│  mention and $85K ARR with renewal in 60 days,     │
│  this is a high-urgency churn signal."              │
│                                                      │
│  [Dry run — no Linear issue created, no state       │
│   updated. Toggle to "live mode" to execute.]       │
└─────────────────────────────────────────────────────┘
```

When `source = 'test'` in dry-run mode:
- Agent classifies normally, returns full AgentDecision
- Does NOT create Linear issues
- Does NOT update customer state
- DOES log to agent_log with event_type = 'test_classification'

Toggle to live mode for full execution (useful for demos).

## CSV Customer Import

The settings/integrations page presents two equal onboarding paths:

```
┌─────────────────────────────────────────────────────┐
│  How should Collie get your customer data?           │
│                                                      │
│  ┌────────────────────┐  ┌────────────────────┐     │
│  │  🔗 Connect        │  │  📄 Upload CSV     │     │
│  │  HubSpot           │  │                    │     │
│  │                    │  │  Upload customers   │     │
│  │  Auto-sync your    │  │  with names,       │     │
│  │  companies + ARR   │  │  domains, and ARR  │     │
│  │                    │  │                    │     │
│  │  [Connect]         │  │  [Upload]          │     │
│  └────────────────────┘  └────────────────────┘     │
│                                                      │
│  Either way, Collie has your customer context        │
│  within minutes.                                     │
└─────────────────────────────────────────────────────┘
```

CSV import: drag-drop file, preview rows, column mapping, upsert into customers table with `revenue_source = 'csv'`.

## API Routes Summary

```
app/
├── api/
│   ├── webhooks/
│   │   ├── intercom/route.ts      ← Intercom → InboundMessage → processInboundMessage
│   │   └── linear/route.ts        ← Ship detection
│   ├── inbound/
│   │   └── message/route.ts       ← Generic API (authenticated via org API key)
│   ├── agent/
│   │   └── classify/route.ts      ← Agent brain (called by processInboundMessage)
│   ├── sync/
│   │   └── hubspot/route.ts       ← Cron: HubSpot → customers table
│   ├── customers/
│   │   ├── route.ts               ← CRUD + list
│   │   ├── [id]/route.ts
│   │   └── import/route.ts        ← CSV upload
│   ├── feedback/
│   │   ├── route.ts               ← CRUD + list
│   │   ├── [id]/route.ts
│   │   └── [id]/assign/route.ts   ← Assign unmatched → customer
│   ├── notifications/
│   │   ├── generate/route.ts
│   │   ├── approve/route.ts       ← Reviewer can edit to_email
│   │   └── send/route.ts          ← Resend
│   └── org/
│       └── api-key/route.ts
├── (dashboard)/
│   ├── page.tsx                   ← Dashboard
│   ├── feedback/                  ← Feedback list + detail
│   ├── customers/                 ← Customer list + detail + import
│   ├── notifications/             ← Queue: review, edit to_email, approve, send
│   ├── unmatched/                 ← Unmatched feedback → assign to customers
│   ├── agent-log/                 ← Agent activity log
│   ├── test/                      ← Test harness + demo
│   └── settings/                  ← Integrations, agent config, API key
├── (auth)/
└── layout.tsx
```

## Build Order (Agent First, Data Import Second)

### Phase 1: Foundation (Days 1-3)
1. Next.js 14 project + TypeScript + Tailwind + shadcn/ui
2. Supabase project + full schema migration
3. Supabase Auth (email/password)
4. Authenticated layout with sidebar
5. All TypeScript interfaces in `/lib/types.ts`
6. AI model config in `/lib/config.ts`
7. Env vars configured
8. **Seed 3-5 test customers via Supabase SQL** (realistic names, domains, ARR, tiers)

### Phase 2: Agent Brain (Days 4-8) ← RISKIEST, BUILD FIRST
1. Customer matching: `/lib/agent/match-customer.ts`
2. AI classification: `/lib/agent/classify.ts`
3. Agent core: `/lib/agent/process.ts` (idempotency → match → classify → execute → log)
4. Action execution: `/lib/agent/execute.ts` (Linear stub for now)
5. Generic inbound API: `/api/inbound/message/route.ts`
6. **Test harness page: `/test/page.tsx`**
7. **Iterate classification prompt until quality is good**
8. **Verify: type messages in test harness → correct classification and reasoning**

### Phase 3: Integrations + Customer Data (Days 9-13)
1. Nango setup: HubSpot + Linear + Intercom
2. HubSpot sync → customers table
3. CSV import endpoint + UI
4. Settings/integrations page (HubSpot connect + CSV upload)
5. Intercom adapter → InboundMessage → processInboundMessage
6. Linear issue creation (replace stub with real API)
7. Register Intercom webhook (ngrok for local dev)
8. **Verify: real Intercom message → feedback + Linear issue with ARR**

### Phase 4: Ship Detection + Notifications (Days 14-17)
1. Linear webhook → ship detection
2. Match shipped issues → feedback records
3. Notification generation (Sonnet)
4. Notification queue UI (review, edit to_email, approve)
5. Resend email delivery
6. **Verify: Linear Done → draft → edit recipient → approve → email sends**

### Phase 5: Web UI (Days 18-22)
1. Dashboard: activity feed, pending reviews, unmatched count
2. Feedback list: filters, sort by ARR
3. Unmatched feedback page: assign to customers
4. Customer list + detail with timeline
5. Notification queue + sent history
6. Agent log
7. Org API key in settings

### Phase 6: Hardening (Days 23-25)
1. Webhook signature verification
2. Rate limiting
3. Retry logic for external APIs
4. Row-level security (org_id scoping)
5. Error handling for unparseable AI JSON
6. Deploy to Vercel + Cron for HubSpot sync

## What to Build / What to Skip

**Build for v1:** Agent core, test harness, Intercom adapter, generic inbound API, HubSpot sync, CSV import, Linear issues, Linear ship detection, notifications, customer matching with fallbacks, unmatched queue, idempotency.

**Skip for v1:** Zendesk/Freshdesk/Slack adapters (build when prospect needs), Salesforce/Stripe sync (build when prospect needs), Jira (build when prospect needs), contacts table (requester fields sufficient), async queue (build if timeouts), desktop app (indefinitely), QBR, health dashboard, Slack notifications, customer portal, mobile app.

**Adding a new tool later:**
- New support tool (Zendesk): 1 new file, transforms payload → InboundMessage. 4-6 hours.
- New issue tracker (Jira): 1 case in executeActions + 1 webhook handler. 1 day.
- New CRM (Salesforce): 1 sync endpoint writing to same customers table. 1 day.

## Environment Variables

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
ANTHROPIC_API_KEY=
NANGO_SECRET_KEY=
NEXT_PUBLIC_NANGO_PUBLIC_KEY=
RESEND_API_KEY=
INTERCOM_WEBHOOK_SECRET=
LINEAR_WEBHOOK_SECRET=
NEXT_PUBLIC_APP_URL=
```

## Success Criteria (25 Days)

- [ ] Test harness: type message → correct AgentDecision with reasoning
- [ ] HubSpot OR CSV → customers appear with ARR
- [ ] Intercom connected → agent classifies real conversations
- [ ] >80% classification accuracy (human review)
- [ ] Unmatched feedback (gmail users) appears in queue, not silently dropped
- [ ] Linear issues include: customer name, ARR, source link, reasoning
- [ ] Ship detection: Linear Done → notification draft
- [ ] Notification defaults to requester email, reviewer can change
- [ ] Notifications are personalized, not generic
- [ ] Duplicate webhooks don't create duplicates (idempotency)
- [ ] Agent log shows reasoning for every action
- [ ] Generic API works: POST InboundMessage → processed
- [ ] New adapter = one new file
- [ ] Infrastructure < $100/month
