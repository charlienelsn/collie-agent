import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
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
 * Generic inbound API: POST InboundMessage → processInboundMessage.
 * Authenticated via org API key in Authorization header.
 */
export async function POST(req: Request) {
  try {
    // 1. Authenticate via org API key
    const authHeader = req.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "Missing or invalid Authorization header. Use Bearer <api_key>." },
        { status: 401 }
      );
    }

    const apiKey = authHeader.slice(7);
    const supabase = createAdminClient();

    const { data: org, error: orgError } = await supabase
      .from("organizations")
      .select("id")
      .eq("api_key", apiKey)
      .single();

    if (orgError || !org) {
      return NextResponse.json(
        { error: "Invalid API key." },
        { status: 401 }
      );
    }

    // 2. Parse and validate the inbound message
    const body = await req.json();

    if (!body.message_text || typeof body.message_text !== "string") {
      return NextResponse.json(
        { error: "message_text is required and must be a string." },
        { status: 400 }
      );
    }

    if (!body.source || !VALID_SOURCES.includes(body.source)) {
      return NextResponse.json(
        { error: `source is required and must be one of: ${VALID_SOURCES.join(", ")}` },
        { status: 400 }
      );
    }

    const message: InboundMessage = {
      customer_domain: body.customer_domain ?? undefined,
      customer_email: body.customer_email ?? undefined,
      customer_name: body.customer_name ?? undefined,
      intercom_company_id: body.intercom_company_id ?? undefined,
      message_text: body.message_text,
      message_html: body.message_html ?? undefined,
      conversation_summary: body.conversation_summary ?? undefined,
      source: body.source,
      source_conversation_id: body.source_conversation_id ?? undefined,
      source_message_id: body.source_message_id ?? undefined,
      source_url: body.source_url ?? undefined,
      timestamp: body.timestamp ?? new Date().toISOString(),
      raw_metadata: body.raw_metadata ?? undefined,
    };

    // 3. Process
    const result = await processInboundMessage(org.id, message);

    if (result.skipped) {
      return NextResponse.json(
        { status: "skipped", reason: result.reason },
        { status: 200 }
      );
    }

    return NextResponse.json({
      status: "processed",
      classification: result.decision?.classification,
      confidence: result.decision?.confidence,
      urgency: result.decision?.urgency,
      feedback_id: result.feedback?.id ?? null,
      match_method: result.matchMethod,
      customer_name: result.customerName,
    });
  } catch (error) {
    console.error("Inbound message processing error:", error);
    return NextResponse.json(
      {
        error: "Internal server error processing message.",
        detail: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
