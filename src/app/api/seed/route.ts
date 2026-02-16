import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * POST /api/seed — Seeds 3 test customers for the authenticated user's org.
 * Only works in development. Idempotent: skips customers that already exist (by domain).
 */
export async function POST() {
  // Only allow in development
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "Seed endpoint disabled in production." },
      { status: 403 }
    );
  }

  try {
    // Get current user's org
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: userRow } = await supabase
      .from("users")
      .select("org_id")
      .eq("id", user.id)
      .single();

    if (!userRow) {
      return NextResponse.json(
        { error: "User not associated with an organization." },
        { status: 403 }
      );
    }

    const orgId = userRow.org_id;
    const admin = createAdminClient();

    const testCustomers = [
      {
        org_id: orgId,
        name: "Acme Corp",
        domain: "acmecorp.com",
        arr: 85000.0,
        mrr: 7083.33,
        tier: "enterprise",
        renewal_date: "2026-04-15",
        account_owner: "Sarah Chen",
        sentiment_trend: "declining",
        interaction_count: 12,
        open_request_count: 2,
        revenue_source: "csv",
        recent_context: [
          {
            date: "2026-02-10",
            channel: "intercom",
            summary:
              "Asked about bulk export timeline. Mentioned team is frustrated with manual workarounds.",
            sentiment: "negative",
            signals: ["feature_request", "complaint"],
          },
          {
            date: "2026-01-28",
            channel: "intercom",
            summary:
              "Requested SSO support for enterprise compliance requirements.",
            sentiment: "neutral",
            signals: ["feature_request"],
          },
          {
            date: "2026-01-15",
            channel: "email",
            summary:
              "Positive feedback on recent API improvements. Asked about roadmap.",
            sentiment: "positive",
            signals: ["praise", "feature_request"],
          },
        ],
      },
      {
        org_id: orgId,
        name: "Globex Inc",
        domain: "globex.io",
        arr: 120000.0,
        mrr: 10000.0,
        tier: "enterprise",
        renewal_date: "2026-07-01",
        account_owner: "Mike Johnson",
        sentiment_trend: "stable",
        interaction_count: 8,
        open_request_count: 1,
        revenue_source: "csv",
        recent_context: [
          {
            date: "2026-02-05",
            channel: "intercom",
            summary:
              "Reported intermittent timeout on dashboard loading. Not blocking but annoying.",
            sentiment: "neutral",
            signals: ["bug"],
          },
          {
            date: "2026-01-20",
            channel: "intercom",
            summary:
              "Asked about multi-file upload feature for their content team.",
            sentiment: "neutral",
            signals: ["feature_request"],
          },
        ],
      },
      {
        org_id: orgId,
        name: "Pied Piper",
        domain: "piedpiper.com",
        arr: 62000.0,
        mrr: 5166.67,
        tier: "growth",
        renewal_date: "2026-03-15",
        account_owner: "Sarah Chen",
        sentiment_trend: "critical",
        interaction_count: 18,
        open_request_count: 3,
        revenue_source: "csv",
        recent_context: [
          {
            date: "2026-02-14",
            channel: "intercom",
            summary:
              "Expressed frustration about 3 open requests with no movement. Mentioned evaluating Competitor X.",
            sentiment: "negative",
            signals: ["churn_risk", "competitor_mention", "complaint"],
          },
          {
            date: "2026-02-01",
            channel: "intercom",
            summary:
              "Follow-up on compression algorithm integration request from December. Still waiting.",
            sentiment: "negative",
            signals: ["escalation", "feature_request"],
          },
          {
            date: "2026-01-10",
            channel: "email",
            summary:
              "Reported data sync bug causing duplicate entries. High priority for their pipeline.",
            sentiment: "negative",
            signals: ["bug"],
          },
        ],
      },
    ];

    const results = [];
    for (const customer of testCustomers) {
      // Check if already exists (idempotent)
      const { data: existing } = await admin
        .from("customers")
        .select("id")
        .eq("org_id", orgId)
        .eq("domain", customer.domain)
        .single();

      if (existing) {
        results.push({ name: customer.name, status: "already_exists", id: existing.id });
        continue;
      }

      const { data, error } = await admin
        .from("customers")
        .insert(customer)
        .select("id")
        .single();

      if (error) {
        results.push({ name: customer.name, status: "error", error: error.message });
      } else {
        results.push({ name: customer.name, status: "created", id: data.id });
      }
    }

    return NextResponse.json({ results });
  } catch (error) {
    console.error("Seed error:", error);
    return NextResponse.json(
      { error: "Seed failed", detail: error instanceof Error ? error.message : "Unknown" },
      { status: 500 }
    );
  }
}
