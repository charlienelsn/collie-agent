# CLAUDE.md — Collie Agent

## Project Overview

Collie is an AI-powered background agent that watches customer support interactions, enriches them with revenue data, creates Linear issues for feature requests/bugs/churn signals, monitors issue completion, and automatically notifies customers when requested features ship.

This is an **always-on background agent** with a lightweight web UI for configuration, review, and override — NOT a dashboard-first product.

## Current State

The project is in early setup (pre-Phase 1). The repo contains:
- `README.md` — minimal placeholder
- `DESIGN.md` — comprehensive 900-line design document (on `main` branch) with full architecture, interfaces, schema, and build plan

No application code has been written yet. DESIGN.md is the authoritative specification.

## Architecture

### Core Principle: Tool-Agnostic Agent + Tool-Specific Adapters

The agent core never touches external tools directly. It consumes normalized `InboundMessage` data and emits normalized `AgentDecision` actions. Adapters translate between external tools (Intercom, Linear, HubSpot) and the agent's internal format.

```
Inbound Adapters → Normalized InboundMessage + CustomerState → AI Classifier → AgentDecision → Outbound Actions
```

### Processing Flow

1. **Idempotency check** — skip if `source_message_id` already processed
2. **Customer matching** — Intercom company ID → domain → email domain → unmatched
3. **Load customer state** — fetch from Supabase with open requests
4. **AI classification** — Claude Haiku classifies message with full context
5. **Create feedback record** — store in Supabase
6. **Execute actions** — create Linear issue, notify human, escalate existing
7. **Log** — record in `agent_log`

## Tech Stack

| Component | Technology |
|-----------|------------|
| Framework | Next.js 14 (App Router) |
| Language | TypeScript (strict mode) |
| Database | Supabase (Postgres) |
| Auth | Supabase Auth |
| Integrations | Nango (OAuth for HubSpot, Linear, Intercom) |
| AI (classification) | Claude Haiku 3.5 via Anthropic API |
| AI (notifications) | Claude Sonnet 4 via Anthropic API |
| Email | Resend |
| Hosting | Vercel (Pro plan, 60s function timeout) |
| Styling | Tailwind CSS + shadcn/ui |

## Planned Directory Structure

```
app/
├── api/
│   ├── webhooks/
│   │   ├── intercom/route.ts     # Intercom → InboundMessage → processInboundMessage
│   │   └── linear/route.ts       # Ship detection webhook
│   ├── inbound/
│   │   └── message/route.ts      # Generic API (org API key auth)
│   ├── agent/
│   │   └── classify/route.ts     # Agent brain endpoint
│   ├── sync/
│   │   └── hubspot/route.ts      # Cron: HubSpot → customers table
│   ├── customers/
│   │   ├── route.ts              # CRUD + list
│   │   ├── [id]/route.ts
│   │   └── import/route.ts       # CSV upload
│   ├── feedback/
│   │   ├── route.ts              # CRUD + list
│   │   ├── [id]/route.ts
│   │   └── [id]/assign/route.ts  # Assign unmatched → customer
│   ├── notifications/
│   │   ├── generate/route.ts
│   │   ├── approve/route.ts
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
│   ├── test/                     # Test harness + demo
│   └── settings/                 # Integrations, config, API key
├── (auth)/                       # Login/signup
└── layout.tsx
lib/
├── agent/
│   ├── match-customer.ts         # Customer matching logic
│   ├── classify.ts               # AI classification prompt + call
│   ├── process.ts                # Core processInboundMessage
│   └── execute.ts                # Action execution (Linear, email, etc.)
├── types.ts                      # All TypeScript interfaces
└── config.ts                     # AI model config, thresholds
```

## Key TypeScript Interfaces

All interfaces are defined in DESIGN.md and should live in `lib/types.ts`:

- **`InboundMessage`** — normalized input from any support channel
- **`CustomerState`** — full customer context including ARR, sentiment, history
- **`AgentDecision`** — classification output with actions, confidence, reasoning
- **`AgentAction`** — union type: `create_issue | escalate_existing | notify_human | no_action`
- **`InboundSource`** — `'intercom' | 'zendesk' | 'email' | 'api' | 'test'` etc.
- **`SignalType`** — `'feature_request' | 'bug' | 'churn_risk' | 'praise' | 'complaint' | 'escalation' | 'competitor_mention'`

## Database Schema

Six core tables in Supabase/Postgres (all scoped by `org_id` for multi-tenancy):

| Table | Purpose |
|-------|---------|
| `organizations` | Multi-tenant orgs with API keys |
| `users` | Org membership + roles (owner/admin/member) |
| `integrations` | Nango connection tracking per provider |
| `customers` | Customer state: domain, ARR, sentiment, recent_context |
| `feedback` | Extracted feedback items with classification + issue tracker links |
| `agent_log` | Activity log for every agent action |
| `notifications` | Notification queue (draft → approved → sent) |

Key constraint: `UNIQUE(org_id, source_type, source_message_id)` on feedback for idempotency.

## Environment Variables

```
# Client-visible (NEXT_PUBLIC_ prefix)
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
NEXT_PUBLIC_NANGO_PUBLIC_KEY=
NEXT_PUBLIC_APP_URL=

# Server-only (never expose to client)
SUPABASE_SERVICE_ROLE_KEY=
ANTHROPIC_API_KEY=
NANGO_SECRET_KEY=
RESEND_API_KEY=
INTERCOM_WEBHOOK_SECRET=
LINEAR_WEBHOOK_SECRET=
```

Never commit `.env` files. Use Vercel environment variables for production.

## AI Model Configuration

Defined as constants in `lib/config.ts` — not hardcoded in prompts:

```typescript
export const AI_MODELS = {
  classification: 'claude-3-5-haiku-latest',   // fast + cheap for per-message classification
  notification: 'claude-sonnet-4-20250514',     // quality for customer-facing content
} as const;
```

- Classification confidence threshold: `0.7` (configurable per org)
- Below-threshold classifications stay in review queue without auto-creating issues

## Build Phases

The project follows a 6-phase build plan (see DESIGN.md for full details):

1. **Phase 1 — Foundation**: Next.js + Supabase + Auth + schema + interfaces + seed data
2. **Phase 2 — Agent Brain** (riskiest, build first): customer matching, AI classification, processInboundMessage, test harness
3. **Phase 3 — Integrations**: Nango setup, HubSpot sync, CSV import, Intercom adapter, Linear issue creation
4. **Phase 4 — Ship Detection + Notifications**: Linear webhook, notification generation (Sonnet), queue UI, Resend delivery
5. **Phase 5 — Web UI**: Dashboard, feedback list, unmatched queue, customer detail, agent log
6. **Phase 6 — Hardening**: Webhook signatures, rate limiting, retries, RLS, error handling

## Development Conventions

### Code Style
- TypeScript strict mode throughout
- Next.js App Router conventions (route handlers in `route.ts`, pages in `page.tsx`)
- All database queries scoped to `org_id` for multi-tenant isolation
- Adapters are single-file, self-contained transformations to/from normalized types

### Agent Design Rules
- Agent core only consumes `InboundMessage` and `CustomerState` — never raw external payloads
- Freemail domains (gmail, yahoo, hotmail, etc.) are skipped during domain matching
- Unmatched feedback is stored with `status: 'unmatched'` — never silently dropped
- All agent actions logged to `agent_log` with reasoning
- Test harness messages use `source: 'test'` and skip side effects in dry-run mode

### Adding New Integrations
- **New support tool** (e.g., Zendesk): 1 adapter file transforming webhook → `InboundMessage`
- **New issue tracker** (e.g., Jira): 1 case in `executeActions` + 1 webhook handler
- **New CRM** (e.g., Salesforce): 1 sync endpoint writing to the same `customers` table

### Security
- Webhook signature verification for Intercom and Linear
- Org API key authentication for generic inbound API
- Row-level security on all tables scoped by `org_id`
- Server-only env vars never prefixed with `NEXT_PUBLIC_`

## Commands

These commands will be available once the project is scaffolded:

```bash
npm run dev          # Start Next.js dev server
npm run build        # Production build
npm run lint         # ESLint
npm run start        # Start production server
```

## Key Design Decisions

1. **Agent-first, not dashboard-first** — the background agent is the product; UI is for config/review/override
2. **Normalized interfaces** — adapters translate external formats; agent core only speaks `InboundMessage`/`AgentDecision`
3. **Haiku for classification, Sonnet for notifications** — cost-optimized AI model selection
4. **Confidence thresholds** — below-threshold classifications require human review before issue creation
5. **Idempotency via source_message_id** — duplicate webhooks never create duplicate feedback
6. **Multi-tenant from day one** — all data scoped by `org_id`
7. **Vercel Pro timeout** — 60s limit; async queue is the upgrade path if needed (don't build until needed)

## Reference

- **DESIGN.md** — full specification with code samples, schema SQL, prompts, and phase details
- Implement one phase at a time; reference DESIGN.md for context but don't build ahead
