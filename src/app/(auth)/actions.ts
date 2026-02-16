"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function login(formData: FormData) {
  const supabase = await createClient();

  const data = {
    email: formData.get("email") as string,
    password: formData.get("password") as string,
  };

  const { error } = await supabase.auth.signInWithPassword(data);

  if (error) {
    return { error: error.message };
  }

  revalidatePath("/", "layout");
  redirect("/");
}

export async function signup(formData: FormData) {
  const supabase = await createClient();
  const adminClient = createAdminClient();

  const email = formData.get("email") as string;
  const password = formData.get("password") as string;
  const name = formData.get("name") as string;
  const orgName = formData.get("orgName") as string;

  // 1. Sign up with Supabase Auth
  const { data: authData, error: authError } = await supabase.auth.signUp({
    email,
    password,
  });

  if (authError) {
    return { error: authError.message };
  }

  if (!authData.user) {
    return { error: "Failed to create user" };
  }

  // 2. Create organization
  const slug = orgName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  const { data: org, error: orgError } = await adminClient
    .from("organizations")
    .insert({ name: orgName, slug })
    .select()
    .single();

  if (orgError) {
    return { error: `Failed to create organization: ${orgError.message}` };
  }

  // 3. Create user record linked to org
  const { error: userError } = await adminClient.from("users").insert({
    id: authData.user.id,
    org_id: org.id,
    email,
    name,
    role: "owner",
  });

  if (userError) {
    return { error: `Failed to create user profile: ${userError.message}` };
  }

  // 4. Create default notification triggers
  await adminClient.from("notification_triggers").insert([
    { org_id: org.id, trigger_type: "shipped", enabled: true },
    { org_id: org.id, trigger_type: "in_progress", enabled: false },
    { org_id: org.id, trigger_type: "stale_request", enabled: false, config: { days_threshold: 30 } },
  ]);

  revalidatePath("/", "layout");
  redirect("/");
}
