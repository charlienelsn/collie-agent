"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function UserNav({ email }: { email: string }) {
  const router = useRouter();

  async function handleSignOut() {
    const res = await fetch("/auth/signout", { method: "POST" });
    if (res.redirected) {
      router.push(new URL(res.url).pathname);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-muted-foreground">{email}</span>
      <Button variant="outline" size="sm" onClick={handleSignOut}>
        Sign out
      </Button>
    </div>
  );
}
