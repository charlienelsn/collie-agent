# CLAUDE.md — Collie Agent

## Project Overview

Collie is an AI-powered background agent that watches customer support interactions, enriches them with revenue data, creates Linear issues for feature requests/bugs/churn signals, monitors issue completion, and automatically notifies customers when requested features ship.

This is an **always-on background agent** with a lightweight web UI for configuration, review, and override — NOT a dashboard-first product.

## Current State

The project is in early setup (pre-Phase 1). The repo contains:
- `README.md` — minimal placeholder (one-line header only)
- `DESIGN.md` — comprehensive 929-line design document (on `origin/main` branch) with full architecture, interfaces, schema, code samples, and build plan
- `CLAUDE.md` — this file

No application code, no `package.json`, no config files, no database migrations have been written yet. **DESIGN.md is the authoritative specification** — read it before implementing any phase.

### Git Structure
- `main` branch on origin contains `DESIGN.md`
- `master` is the local default branch (initial commit with `README.md` only)
- Feature branches off `main` for development

## Architecture

### Core Principle: Tool-Agnostic Agent + Tool-Specific Adapters

The agent core never touches Intercom, HubSpot, or Linear directly. It consumes normalized data and emits normalized actions. Adapters translate between external tools and the agent's internal format.

```
┌──────────────────────────────────────────────────────────────────┐
│  INBOUND ADAPTERS          AGENT CORE           OUTBOUND ACTIONS │
│                                                                  │
│  Intercom Adapter ──┐  ┌──────────────────┐  ┌─ Create issue    │
│  Zendesk (v1.1) ────┤  │ InboundMessage   │  │  (Linear)        │
│  Generic API ───────┘  │ + CustomerState   │──┤─ Send notif      │
│                        │ + AI Classifier   │  │  (Resend)        │
│                        │ = AgentDecision   │  └─ Update state    │
│                        └──────────────────┘     (Supabase)       │
│                                                                  │
│  CUSTOMER DATA SOURCES         SHIP DETECTION                    │
│  HubSpot Sync ──┐             Linear Webhook                     │
│  CSV Import ────┤─→ customers    → Match to feedback             │
│  Stripe (v1.1) ─┘   table         → Queue notification           │
└──────────────────────────────────────────────────────────────────┘
```

### Processing Flow (`processInboundMessage`)

1. **Idempotency check** — skip if `source_message_id` already exists in feedback table
2. **Customer matching** — fallback chain: Intercom company ID → explicit domain → email domain → `null` (unmatched)
3. **Load customer state** — fetch `CustomerState` + open requests from Supabase
4. **AI classification** — Claude Haiku classifies message with full customer context
5. **Skip if "none"** — just update interaction context and log
6. **Create feedback record** — store in Supabase (status: `'new'` if matched, `'unmatched'` if not)
7. **Execute actions** — only if customer matched: create Linear issue, notify human, escalate existing
8. **Log** — record in `agent_log` with reasoning

### Customer Matching Fallback Chain

Priority order (stop at first match):
1. `intercom_company_id` → most reliable
2. `customer_domain` → skip freemail domains
3. Email domain extracted from `customer_email` → skip freemail domains
4. No match → feedback created as `status: 'unmatched'`

Freemail domains to skip: `gmail.com`, `yahoo.com`, `hotmail.com`, `outlook.com`, `aol.com`, `icloud.com`, `mail.com`, `protonmail.com`, `zoho.com`, `yandex.com`, `live.com`, `msn.com`

### Confidence Threshold

- Default: `0.7` (configurable per org)
- Below threshold: feedback stays in review queue, no Linear issue auto-created
- Above threshold: actions execute automatically

## Tech Stack

| Component | Technology | Reason |
|-----------|------------|--------|
| Framework | Next.js 14 (App Router) | API routes for webhooks + lightweight UI |
| Language | TypeScript (strict mode) | Type safety for integration payloads |
| Database | Supabase (Postgres) | Customer state, agent logs, feedback records |
| Auth | Supabase Auth | Multi-tenant, org-level isolation |
| Integrations | Nango | OAuth management for HubSpot, Linear, Intercom |
| AI (classification) | Claude Haiku 3.5 via Anthropic API | Fast, cheap per-message classification |
| AI (notifications) | Claude Sonnet 4 via Anthropic API | Customer-facing content needs quality |
| Email delivery | Resend | Transactional emails for customer notifications |
| Hosting | Vercel (Pro plan, 60s timeout) | Edge-optimized deployment |
| Styling | Tailwind CSS + shadcn/ui | Fast UI development |

## Directory Structure (Planned)

```
app/
├── api/
│   ├── webhooks/
│   │   ├── intercom/route.ts     # Intercom → InboundMessage → processInboundMessage
│   │   └── linear/route.ts       # Ship detection: issue Done → notification draft
│   ├── inbound/
│   │   └── message/route.ts      # Generic API (org API key auth)
│   ├── agent/
│   │   └── classify/route.ts     # Agent brain endpoint
│   ├── sync/
│   │   └── hubspot/route.ts      # Cron: HubSpot → customers table
│   ├── customers/
│   │   ├── route.ts              # CRUD + list
│   │   ├── [id]/route.ts
│   │   └── import/route.ts       # CSV upload with column mapping
│   ├── feedback/
│   │   ├── route.ts              # CRUD + list
│   │   ├── [id]/route.ts
│   │   └── [id]/assign/route.ts  # Assign unmatched feedback → customer
│   ├── notifications/
│   │   ├── generate/route.ts     # AI-generated notification draft (Sonnet)
│   │   ├── approve/route.ts      # Reviewer can edit to_email before approving
│   │   └── send/route.ts         # Resend delivery
│   └── org/
│       └── api-key/route.ts
├── (dashboard)/
│   ├── page.tsx                  # Dashboard / activity feed
│   ├── feedback/                 # Feedback list + detail
│   ├── customers/                # Customer list + detail + import
│   ├── notifications/            # Queue: review, edit, approve, send
│   ├── unmatched/                # Unmatched feedback assignment
│   ├── agent-log/                # Agent activity log
│   ├── test/                     # Test harness (dry-run + live mode)
│   └── settings/                 # Integrations, config, API key
├── (auth)/                       # Login/signup
└── layout.tsx                    # Authenticated layout with sidebar
lib/
├── agent/
│   ├── match-customer.ts         # Customer matching fallback chain
│   ├── classify.ts               # AI classification prompt + Anthropic API call
│   ├── process.ts                # Core processInboundMessage orchestrator
│   └── execute.ts                # Action execution (Linear, email, escalate)
├── types.ts                      # All TypeScript interfaces (InboundMessage, CustomerState, AgentDecision, etc.)
└── config.ts                     # AI model IDs, confidence thresholds
```

## Key TypeScript Interfaces

All defined in DESIGN.md — implement in `lib/types.ts`:

### `InboundMessage` — Normalized input from any support channel
- Customer identification: `customer_domain?`, `customer_email?`, `customer_name?`, `intercom_company_id?`
- Message: `message_text` (required), `message_html?`, `conversation_summary?`
- Source metadata: `source: InboundSource`, `source_conversation_id?`, `source_message_id?` (idempotency), `source_url?`
- `timestamp: string` (ISO 8601), `raw_metadata?: Record<string, unknown>`

### `InboundSource` — Union type
`'intercom' | 'zendesk' | 'freshdesk' | 'helpscout' | 'email' | 'slack' | 'api' | 'manual' | 'test'`

### `CustomerState` — Full customer context for classification
- Identity: `id`, `name`, `domain`
- Revenue: `arr?`, `mrr?`, `tier?`, `renewal_date?`, `days_until_renewal?`
- Relationship: `account_owner?`, `deal_stage?`
- Agent state: `sentiment_trend` (improving/stable/declining/critical), `interaction_count`, `open_request_count`
- History: `recent_context: InteractionSummary[]` (last 10), `open_requests: OpenRequest[]`

### `AgentDecision` — Classification output
- `classification`: `'feature_request' | 'bug' | 'churn_signal' | 'praise' | 'complaint' | 'none'`
- `confidence`: `0.0` to `1.0`
- `title?`, `detail?`, `urgency`: `'critical' | 'high' | 'normal' | 'low'`
- `actions: AgentAction[]`, `reasoning: string`
- `sentiment_update?`, `new_interaction_summary: InteractionSummary`
- `related_feedback_id?` (when escalating existing)

### `AgentAction` — Union type
- `{ type: 'create_issue'; title: string; detail: string; urgency: string }`
- `{ type: 'escalate_existing'; feedback_id: string; reason: string }`
- `{ type: 'notify_human'; reason: string; urgency: 'critical' | 'high' }`
- `{ type: 'no_action' }`

### `SignalType`
`'feature_request' | 'bug' | 'churn_risk' | 'praise' | 'complaint' | 'escalation' | 'competitor_mention'`

### `CustomerImportRow` — CSV import shape
Required: `name`, `domain`. Optional: `arr`, `mrr`, `tier`, `renewal_date`, `account_owner`, `hubspot_company_id`, `intercom_company_id`

## Database Schema

Seven tables in Supabase/Postgres, all scoped by `org_id` for multi-tenancy:

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `organizations` | Multi-tenant orgs | `id`, `name`, `slug` (unique), `api_key` (unique) |
| `users` | Org membership | `id` (refs auth.users), `org_id`, `email`, `role` (owner/admin/member) |
| `integrations` | Nango connection tracking | `org_id`, `provider` (hubspot/linear/intercom/zendesk/stripe), `nango_connection_id`, `status`, `config` JSONB |
| `customers` | Customer state (tool-agnostic) | `org_id`, `domain`, `arr`, `mrr`, `sentiment_trend`, `recent_context` JSONB, `hubspot_company_id`, `intercom_company_id`, `stripe_customer_id`, `revenue_source` |
| `feedback` | Extracted feedback items | `org_id`, `customer_id` (nullable for unmatched), `type`, `title`, `urgency`, `confidence`, `status` (new/reviewed/accepted/rejected/merged/unmatched), `issue_tracker_*`, `shipped_at` |
| `agent_log` | Activity log | `org_id`, `event_type`, `customer_id`, `feedback_id`, `details` JSONB |
| `notifications` | Notification queue | `org_id`, `customer_id`, `feedback_id`, `subject`, `body_html`, `to_email`, `status` (draft/approved/sent/failed) |

### Critical Constraints & Indexes
- **Idempotency**: `UNIQUE(org_id, source_type, source_message_id) WHERE source_message_id IS NOT NULL` on `feedback`
- **Integration uniqueness**: `UNIQUE(org_id, provider)` on `integrations`
- **Performance indexes**: on `org_id`, `customer_id`, `domain`, `status`, `type`, `issue_tracker_id`, `customer_arr DESC`
- **Feedback.customer_id is NULLABLE**: unmatched feedback has no customer link
- **Feedback source_type CHECK**: includes `'call_transcript'` in addition to `InboundSource` values

## AI Classification Details

### Model Config (`lib/config.ts`)

```typescript
export const AI_MODELS = {
  classification: 'claude-3-5-haiku-latest',   // fast + cheap; swap to Sonnet if quality insufficient
  notification: 'claude-sonnet-4-20250514',     // always Sonnet for customer-facing content
} as const;
```

### Classification Rules
- **feature_request**: Asking for new functionality
- **bug**: Reporting something broken
- **churn_signal**: Frustration, competitor mentions, "considering alternatives"
- **praise**: Expressing satisfaction
- **complaint**: Unhappy about process/timeline (not a specific bug/feature)
- **none**: Normal support, greeting, logistics — no actionable signal

### Urgency Rules
- **critical**: High ARR (>$50K) + negative sentiment + renewal <90 days, OR explicit churn threat
- **high**: High ARR + negative, OR repeated escalation
- **normal**: Standard request
- **low**: Low ARR + non-urgent + first mention
- Unknown customer defaults to **normal** unless explicitly urgent

### Pattern Detection
- Same issue mentioned before → escalation, not new request
- Sentiment declining across interactions
- Open requests stale while renewal approaches
- Competitor mentioned by name

## Ship Detection & Notifications

### Flow
1. Linear webhook fires when issue status changes
2. Verify webhook signature
3. Check if new status is in org's `shipped_statuses` config
4. Find feedback records linked via `issue_tracker_id`
5. Set `shipped_at`, generate notification draft using Claude Sonnet
6. Draft enters notification queue for human review
7. Reviewer can edit `to_email` (defaults to `requester_email`) before approving
8. Approved notifications sent via Resend

### Notification Rules
- 3-5 sentences max, human tone
- Reference the customer's specific request
- Include CTA (try it out, changelog link)
- Never use: "We're excited", "We're thrilled", "We value your feedback"

## Test Harness

Built in Phase 2, serves as both development testing tool and sales demo.

- **Dry-run mode** (`source: 'test'`): classifies normally, returns full `AgentDecision`, does NOT create Linear issues or update customer state, DOES log with `event_type: 'test_classification'`
- **Live mode**: full execution including side effects (for demos)
- UI: select customer (or "Unknown"), enter message, pick source, run agent, see classification + reasoning

## Environment Variables

```
# Client-visible (NEXT_PUBLIC_ prefix)
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
NEXT_PUBLIC_NANGO_PUBLIC_KEY=
NEXT_PUBLIC_APP_URL=

# Server-only (never expose to client, never prefix with NEXT_PUBLIC_)
SUPABASE_SERVICE_ROLE_KEY=
ANTHROPIC_API_KEY=
NANGO_SECRET_KEY=
RESEND_API_KEY=
INTERCOM_WEBHOOK_SECRET=
LINEAR_WEBHOOK_SECRET=
```

Never commit `.env` files. Use Vercel environment variables for production.

## Build Phases

Implement one phase at a time. Reference DESIGN.md for full details and code samples.

### Phase 1 — Foundation (Days 1-3)
1. Next.js 14 + TypeScript + Tailwind + shadcn/ui
2. Supabase project + full schema migration (all 7 tables)
3. Supabase Auth (email/password)
4. Authenticated layout with sidebar
5. All TypeScript interfaces in `lib/types.ts`
6. AI model config in `lib/config.ts`
7. Env vars configured
8. **Seed 3-5 test customers via Supabase SQL** (realistic names, domains, ARR, tiers)

### Phase 2 — Agent Brain (Days 4-8) **RISKIEST — BUILD FIRST**
1. Customer matching: `lib/agent/match-customer.ts`
2. AI classification: `lib/agent/classify.ts`
3. Agent core: `lib/agent/process.ts` (idempotency → match → classify → execute → log)
4. Action execution: `lib/agent/execute.ts` (Linear stub for now)
5. Generic inbound API: `app/api/inbound/message/route.ts`
6. **Test harness page: `app/(dashboard)/test/page.tsx`**
7. **Iterate classification prompt until quality is good**
8. **Verify: type messages in test harness → correct classification and reasoning**

### Phase 3 — Integrations + Customer Data (Days 9-13)
1. Nango setup: HubSpot + Linear + Intercom
2. HubSpot sync → customers table
3. CSV import endpoint + UI
4. Settings/integrations page (HubSpot connect + CSV upload)
5. Intercom adapter → InboundMessage → processInboundMessage
6. Linear issue creation (replace stub with real API)
7. Register Intercom webhook (ngrok for local dev)
8. **Verify: real Intercom message → feedback + Linear issue with ARR**

### Phase 4 — Ship Detection + Notifications (Days 14-17)
1. Linear webhook → ship detection
2. Match shipped issues → feedback records
3. Notification generation (Sonnet)
4. Notification queue UI (review, edit to_email, approve)
5. Resend email delivery
6. **Verify: Linear Done → draft → edit recipient → approve → email sends**

### Phase 5 — Web UI (Days 18-22)
1. Dashboard: activity feed, pending reviews, unmatched count
2. Feedback list: filters, sort by ARR
3. Unmatched feedback page: assign to customers
4. Customer list + detail with timeline
5. Notification queue + sent history
6. Agent log
7. Org API key in settings

### Phase 6 — Hardening (Days 23-25)
1. Webhook signature verification (Intercom + Linear)
2. Rate limiting
3. Retry logic for external APIs
4. Row-level security (org_id scoping)
5. Error handling for unparseable AI JSON responses
6. Deploy to Vercel + Cron for HubSpot sync

## Scope

### Build for v1
Agent core, test harness, Intercom adapter, generic inbound API, HubSpot sync, CSV import, Linear issues, Linear ship detection, notifications, customer matching with fallbacks, unmatched queue, idempotency.

### Skip for v1
Zendesk/Freshdesk/Slack adapters, Salesforce/Stripe sync, Jira, contacts table (requester fields on feedback are sufficient), async queue (build only if timeouts occur), desktop app, QBR, health dashboard, Slack notifications, customer portal, mobile app.

### Adding Integrations Later
- **New support tool** (e.g., Zendesk): 1 adapter file transforming webhook payload → `InboundMessage`
- **New issue tracker** (e.g., Jira): 1 case in `executeActions` + 1 webhook handler
- **New CRM** (e.g., Salesforce): 1 sync endpoint writing to the same `customers` table

## Development Conventions

### Code Style
- TypeScript strict mode throughout
- Next.js App Router conventions (route handlers in `route.ts`, pages in `page.tsx`)
- All database queries scoped to `org_id` for multi-tenant isolation
- Adapters are single-file, self-contained transformations to/from normalized types
- AI model IDs defined as constants in `lib/config.ts` — never hardcoded in prompts

### Agent Design Rules
- Agent core only consumes `InboundMessage` and `CustomerState` — never raw external payloads
- Freemail domains skipped during domain matching (see list above)
- Unmatched feedback stored with `status: 'unmatched'` — never silently dropped
- All agent actions logged to `agent_log` with reasoning
- Test harness messages use `source: 'test'` and skip side effects in dry-run mode
- Actions only execute when customer is matched — no Linear issues without customer context

### Security
- Webhook signature verification for Intercom and Linear
- Org API key authentication for generic inbound API
- Row-level security on all tables scoped by `org_id`
- Server-only env vars never prefixed with `NEXT_PUBLIC_`
- Never commit `.env` files

### Timeout Strategy
- Vercel Pro allows 60s function timeout
- Full processing chain (webhook → classify → execute) completes in 5-15 seconds
- If timeouts occur: upgrade path is `inbound_queue` table + Vercel Cron processing every minute
- Don't build the queue until actually needed

## Commands

Available once scaffolded (Phase 1):

```bash
npm run dev          # Start Next.js dev server
npm run build        # Production build
npm run lint         # ESLint
npm run start        # Start production server
```

## Key Design Decisions

1. **Agent-first, not dashboard-first** — the background agent is the product; UI is for config/review/override
2. **Normalized interfaces** — adapters translate external formats; agent core only speaks `InboundMessage`/`AgentDecision`
3. **Haiku for classification, Sonnet for notifications** — cost-optimized AI model selection per use case
4. **Confidence thresholds** — below-threshold classifications require human review before issue creation
5. **Idempotency via source_message_id** — `UNIQUE` DB constraint + application-level check prevents duplicate processing
6. **Multi-tenant from day one** — all data scoped by `org_id`, RLS on all tables
7. **Vercel Pro timeout** — 60s limit; async queue is the upgrade path if needed (don't build until needed)
8. **Unmatched feedback visible** — never silently drop feedback from unknown customers; queue for manual assignment

## Success Criteria

- Test harness: type message → correct `AgentDecision` with reasoning
- HubSpot OR CSV → customers appear with ARR
- Intercom connected → agent classifies real conversations
- >80% classification accuracy (human review)
- Unmatched feedback (gmail users) appears in queue, not silently dropped
- Linear issues include: customer name, ARR, source link, reasoning
- Ship detection: Linear Done → notification draft
- Notifications default to requester email, reviewer can change
- Notifications are personalized, not generic
- Duplicate webhooks don't create duplicates (idempotency)
- Agent log shows reasoning for every action
- Generic API works: POST `InboundMessage` → processed
- New adapter = one new file
- Infrastructure < $100/month

## Reference

- **DESIGN.md** (on `main` branch) — full 929-line specification with code samples, SQL schema, AI prompts, and phase details
- Implement one phase at a time; reference DESIGN.md for context but don't build ahead
