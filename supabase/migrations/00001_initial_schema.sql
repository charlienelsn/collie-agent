-- Collie Agent — Initial Schema Migration
-- All tables scoped by org_id for multi-tenancy

-- ============================================================
-- Organizations
-- ============================================================
CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  api_key TEXT UNIQUE,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- Users (org membership, references Supabase auth.users)
-- ============================================================
CREATE TABLE users (
  id UUID PRIMARY KEY REFERENCES auth.users(id),
  org_id UUID REFERENCES organizations(id) NOT NULL,
  email TEXT NOT NULL,
  name TEXT,
  role TEXT DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- Integrations (Nango connection tracking)
-- ============================================================
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

-- ============================================================
-- Customers (tool-agnostic customer state)
-- ============================================================
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

-- ============================================================
-- Feedback (extracted by agent)
-- ============================================================
CREATE TABLE feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) NOT NULL,
  customer_id UUID REFERENCES customers(id),
  type TEXT NOT NULL CHECK (type IN ('feature_request', 'bug', 'churn_signal', 'praise', 'complaint')),
  title TEXT NOT NULL,
  detail TEXT,
  urgency TEXT DEFAULT 'normal' CHECK (urgency IN ('critical', 'high', 'normal', 'low')),
  customer_arr DECIMAL(12,2),
  customer_name TEXT,
  requester_email TEXT,
  requester_name TEXT,
  source_type TEXT NOT NULL CHECK (source_type IN ('intercom', 'zendesk', 'freshdesk', 'helpscout', 'email', 'slack', 'api', 'manual', 'call_transcript', 'test')),
  source_id TEXT,
  source_message_id TEXT,
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

-- ============================================================
-- Agent Log
-- ============================================================
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

-- ============================================================
-- Notifications
-- ============================================================
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) NOT NULL,
  customer_id UUID REFERENCES customers(id) NOT NULL,
  feedback_id UUID REFERENCES feedback(id) NOT NULL,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN (
    'shipped',
    'in_progress',
    'stale_request',
    'customer_followup',
    'manual'
  )),
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  body_plain TEXT NOT NULL,
  to_email TEXT NOT NULL,
  to_name TEXT,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'sent', 'failed')),
  approved_by UUID REFERENCES users(id),
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- Feedback Status History (tracks every status change)
-- ============================================================
CREATE TABLE feedback_status_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feedback_id UUID REFERENCES feedback(id) NOT NULL,
  old_status TEXT,
  new_status TEXT NOT NULL,
  changed_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_feedback_status_history ON feedback_status_history(feedback_id, changed_at DESC);

-- ============================================================
-- Notification Trigger Configuration (per org)
-- ============================================================
CREATE TABLE notification_triggers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) NOT NULL,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('shipped', 'in_progress', 'stale_request')),
  enabled BOOLEAN DEFAULT true,
  config JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, trigger_type)
);

-- ============================================================
-- Row Level Security Policies
-- ============================================================

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_triggers ENABLE ROW LEVEL SECURITY;

-- Users can read their own org
CREATE POLICY "Users can view own org" ON organizations
  FOR SELECT USING (
    id IN (SELECT org_id FROM users WHERE id = auth.uid())
  );

-- Users can read/write within their org
CREATE POLICY "Users can view org members" ON users
  FOR SELECT USING (
    org_id IN (SELECT org_id FROM users WHERE id = auth.uid())
  );

CREATE POLICY "Users can view own profile" ON users
  FOR ALL USING (id = auth.uid());

-- Org-scoped policies for data tables
CREATE POLICY "Org isolation" ON integrations
  FOR ALL USING (
    org_id IN (SELECT org_id FROM users WHERE id = auth.uid())
  );

CREATE POLICY "Org isolation" ON customers
  FOR ALL USING (
    org_id IN (SELECT org_id FROM users WHERE id = auth.uid())
  );

CREATE POLICY "Org isolation" ON feedback
  FOR ALL USING (
    org_id IN (SELECT org_id FROM users WHERE id = auth.uid())
  );

CREATE POLICY "Org isolation" ON agent_log
  FOR ALL USING (
    org_id IN (SELECT org_id FROM users WHERE id = auth.uid())
  );

CREATE POLICY "Org isolation" ON notifications
  FOR ALL USING (
    org_id IN (SELECT org_id FROM users WHERE id = auth.uid())
  );

CREATE POLICY "Org isolation" ON notification_triggers
  FOR ALL USING (
    org_id IN (SELECT org_id FROM users WHERE id = auth.uid())
  );

CREATE POLICY "Org isolation" ON feedback_status_history
  FOR ALL USING (
    feedback_id IN (
      SELECT id FROM feedback WHERE org_id IN (
        SELECT org_id FROM users WHERE id = auth.uid()
      )
    )
  );
