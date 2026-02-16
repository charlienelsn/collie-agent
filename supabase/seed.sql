-- Seed data: test customers for development
-- Run this after creating an organization via the signup flow.
-- Replace '<YOUR_ORG_ID>' with the actual org UUID from the organizations table.

-- Example: INSERT INTO customers ...
-- You can run this via Supabase SQL Editor after signing up.

-- Acme Corp — high ARR, declining sentiment, renewal soon
INSERT INTO customers (org_id, name, domain, arr, mrr, tier, renewal_date, account_owner, sentiment_trend, interaction_count, open_request_count, revenue_source)
VALUES (
  '<YOUR_ORG_ID>',
  'Acme Corp',
  'acmecorp.com',
  85000.00,
  7083.33,
  'enterprise',
  '2026-04-15',
  'Sarah Chen',
  'declining',
  12,
  2,
  'csv'
);

-- Globex Inc — highest ARR, stable, mid-year renewal
INSERT INTO customers (org_id, name, domain, arr, mrr, tier, renewal_date, account_owner, sentiment_trend, interaction_count, open_request_count, revenue_source)
VALUES (
  '<YOUR_ORG_ID>',
  'Globex Inc',
  'globex.io',
  120000.00,
  10000.00,
  'enterprise',
  '2026-07-01',
  'Mike Johnson',
  'stable',
  8,
  1,
  'csv'
);

-- Initech — mid ARR, improving sentiment, no open requests
INSERT INTO customers (org_id, name, domain, arr, mrr, tier, renewal_date, account_owner, sentiment_trend, interaction_count, open_request_count, revenue_source)
VALUES (
  '<YOUR_ORG_ID>',
  'Initech',
  'initech.com',
  45000.00,
  3750.00,
  'growth',
  '2026-09-30',
  'Sarah Chen',
  'improving',
  5,
  0,
  'csv'
);

-- Hooli — small ARR, new customer, stable
INSERT INTO customers (org_id, name, domain, arr, mrr, tier, renewal_date, account_owner, sentiment_trend, interaction_count, open_request_count, revenue_source)
VALUES (
  '<YOUR_ORG_ID>',
  'Hooli',
  'hooli.xyz',
  12000.00,
  1000.00,
  'starter',
  '2026-12-01',
  'Mike Johnson',
  'stable',
  2,
  0,
  'csv'
);

-- Pied Piper — mid ARR, critical sentiment, renewal imminent
INSERT INTO customers (org_id, name, domain, arr, mrr, tier, renewal_date, account_owner, sentiment_trend, interaction_count, open_request_count, revenue_source)
VALUES (
  '<YOUR_ORG_ID>',
  'Pied Piper',
  'piedpiper.com',
  62000.00,
  5166.67,
  'growth',
  '2026-03-15',
  'Sarah Chen',
  'critical',
  18,
  3,
  'csv'
);
