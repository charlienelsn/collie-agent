import { createAdminClient } from "@/lib/supabase/admin";
import type { InboundMessage, Customer } from "@/lib/types";
import { FREEMAIL_DOMAINS } from "@/lib/types";

export interface MatchResult {
  customer: Customer | null;
  matchMethod: "intercom_company_id" | "domain" | "email_domain" | "none";
}

/**
 * Customer matching fallback chain:
 * 1. intercom_company_id (most reliable)
 * 2. customer_domain (skip freemail)
 * 3. email domain extracted from customer_email (skip freemail)
 * 4. No match → feedback created as unmatched
 */
export async function findCustomer(
  orgId: string,
  message: InboundMessage
): Promise<MatchResult> {
  const supabase = createAdminClient();

  // 1. Intercom company ID (most reliable if available)
  if (message.intercom_company_id) {
    const { data } = await supabase
      .from("customers")
      .select("*")
      .eq("org_id", orgId)
      .eq("intercom_company_id", message.intercom_company_id)
      .single();
    if (data) return { customer: data as Customer, matchMethod: "intercom_company_id" };
  }

  // 2. Explicit domain (skip freemail)
  if (message.customer_domain && !FREEMAIL_DOMAINS.has(message.customer_domain)) {
    const { data } = await supabase
      .from("customers")
      .select("*")
      .eq("org_id", orgId)
      .eq("domain", message.customer_domain)
      .single();
    if (data) return { customer: data as Customer, matchMethod: "domain" };
  }

  // 3. Extract domain from email (skip freemail)
  if (message.customer_email) {
    const emailDomain = message.customer_email.split("@")[1];
    if (emailDomain && !FREEMAIL_DOMAINS.has(emailDomain)) {
      const { data } = await supabase
        .from("customers")
        .select("*")
        .eq("org_id", orgId)
        .eq("domain", emailDomain)
        .single();
      if (data) return { customer: data as Customer, matchMethod: "email_domain" };
    }
  }

  // 4. No match
  return { customer: null, matchMethod: "none" };
}
