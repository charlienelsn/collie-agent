import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { processInboundMessage } from "@/lib/agent/process";
import type { InboundMessage, InboundSource } from "@/lib/types";

const VALID_SOURCES: InboundSource[] = [
  "intercom",
  "zendesk",
  "freshdesk",
  "helpscout",
  "email",
  "slack",
  "api",
  "manual",
  "test",
];

/**
 * Agent brain endpoint for the test harness.
 * Authenticated via Supabase session (user must be logged in).
 * Supports dry-run mode (default) and live mode.
 */
export async function POST(req: Request) {
  try {
    // 1. Authenticate via session
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get user's org
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

    // 2. Parse request
    const body = await req.json();
    const { message_text, source, customer_id, live_mode } = body;

    if (!message_text || typeof message_text !== "string") {
      return NextResponse.json(
        { error: "message_text is required." },
        { status: 400 }
      );
    }

    const messageSource: InboundSource =
      source && VALID_SOURCES.includes(source) ? source : "test";
    const isDryRun = !live_mode;

    // 3. Build InboundMessage
    // If customer_id is provided, look up customer to pre-fill domain/email
    let customerDomain: string | undefined;
    let customerName: string | undefined;

    if (customer_id && customer_id !== "unknown") {
      const { data: customer } = await supabase
        .from("customers")
        .select("domain, name")
        .eq("id", customer_id)
        .single();

      if (customer) {
        customerDomain = customer.domain;
        customerName = customer.name;
      }
    }

    const message: InboundMessage = {
      customer_domain: customerDomain,
      customer_name: customerName,
      message_text,
      source: messageSource,
      timestamp: new Date().toISOString(),
    };

    // 4. Process (dry-run by default)
    const result = await processInboundMessage(
      userRow.org_id,
      message,
      isDryRun
    );

    return NextResponse.json({
      status: isDryRun ? "dry_run" : "live",
      skipped: result.skipped,
      reason: result.reason,
      decision: result.decision ?? null,
      feedback_id: result.feedback?.id ?? null,
      match_method: result.matchMethod,
      customer_name: result.customerName,
    });
  } catch (error) {
    console.error("Agent classify error:", error);
    return NextResponse.json(
      {
        error: "Classification failed.",
        detail: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
