"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { createClient } from "@/lib/supabase/client";

interface CustomerOption {
  id: string;
  name: string;
  domain: string;
  arr: number | null;
  tier: string | null;
}

interface AgentDecisionResponse {
  status: string;
  skipped: boolean;
  reason?: string;
  decision: {
    classification: string;
    confidence: number;
    title?: string;
    detail?: string;
    urgency: string;
    actions: Array<{ type: string; [key: string]: unknown }>;
    sentiment_update?: string;
    reasoning: string;
    related_feedback_id?: string;
    new_interaction_summary: {
      summary: string;
      sentiment: string;
      signals: string[];
    };
  } | null;
  feedback_id: string | null;
  match_method: string;
  customer_name: string | null;
  error?: string;
  detail?: string;
}

const SOURCES = [
  "intercom",
  "zendesk",
  "freshdesk",
  "helpscout",
  "email",
  "slack",
  "api",
  "manual",
  "test",
] as const;

const urgencyColors: Record<string, string> = {
  critical: "bg-red-600 text-white",
  high: "bg-orange-500 text-white",
  normal: "bg-blue-500 text-white",
  low: "bg-gray-400 text-white",
};

const classificationColors: Record<string, string> = {
  feature_request: "bg-purple-600 text-white",
  bug: "bg-red-500 text-white",
  churn_signal: "bg-orange-600 text-white",
  praise: "bg-green-600 text-white",
  complaint: "bg-yellow-600 text-white",
  none: "bg-gray-500 text-white",
};

export default function TestHarnessPage() {
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<string>("unknown");
  const [messageText, setMessageText] = useState("");
  const [source, setSource] = useState<string>("intercom");
  const [liveMode, setLiveMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AgentDecisionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load customers on mount
  useEffect(() => {
    async function loadCustomers() {
      const supabase = createClient();
      const { data } = await supabase
        .from("customers")
        .select("id, name, domain, arr, tier")
        .order("arr", { ascending: false, nullsFirst: false });

      if (data) {
        setCustomers(data as CustomerOption[]);
      }
    }
    loadCustomers();
  }, []);

  async function runAgent() {
    setLoading(true);
    setResult(null);
    setError(null);

    try {
      const response = await fetch("/api/agent/classify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message_text: messageText,
          source,
          customer_id: selectedCustomer,
          live_mode: liveMode,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "Request failed");
        return;
      }

      setResult(data as AgentDecisionResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Test Collie Agent</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Classify customer messages with the AI agent.{" "}
          {liveMode
            ? "Live mode — actions will execute."
            : "Dry run — no side effects."}
        </p>
      </div>

      <Card>
        <CardContent className="space-y-4 pt-6">
          {/* Customer selector */}
          <div className="space-y-2">
            <Label htmlFor="customer">Customer</Label>
            <Select value={selectedCustomer} onValueChange={setSelectedCustomer}>
              <SelectTrigger id="customer">
                <SelectValue placeholder="Select a customer" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="unknown">Unknown (unmatched)</SelectItem>
                {customers.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name} ({c.domain})
                    {c.arr ? ` — $${(c.arr / 1000).toFixed(0)}K` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Message input */}
          <div className="space-y-2">
            <Label htmlFor="message">Message</Label>
            <Textarea
              id="message"
              placeholder="Hey, we really need bulk export for our team. We've been asking about this for months and honestly we're starting to look at competitors."
              value={messageText}
              onChange={(e) => setMessageText(e.target.value)}
              rows={4}
            />
          </div>

          {/* Source selector */}
          <div className="space-y-2">
            <Label htmlFor="source">Source</Label>
            <Select value={source} onValueChange={setSource}>
              <SelectTrigger id="source">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SOURCES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Mode toggle + Run button */}
          <div className="flex items-center gap-4">
            <Button
              onClick={runAgent}
              disabled={loading || !messageText.trim()}
              className="min-w-[120px]"
            >
              {loading ? "Running..." : "Run Agent"}
            </Button>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={liveMode}
                onChange={(e) => setLiveMode(e.target.checked)}
                className="rounded border-gray-300"
              />
              <span className={liveMode ? "font-medium text-orange-600" : "text-muted-foreground"}>
                Live mode
              </span>
            </label>
          </div>
        </CardContent>
      </Card>

      {/* Error display */}
      {error && (
        <Card className="border-red-300 bg-red-50">
          <CardContent className="pt-6">
            <p className="text-sm text-red-700">{error}</p>
          </CardContent>
        </Card>
      )}

      {/* Results */}
      {result && result.decision && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              Agent Decision
              <Badge variant="outline" className="text-xs">
                {result.status === "dry_run" ? "Dry Run" : "Live"}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Classification + Confidence */}
            <div className="flex flex-wrap gap-3">
              <div>
                <span className="text-xs text-muted-foreground">Classification</span>
                <div className="mt-1">
                  <Badge className={classificationColors[result.decision.classification] ?? ""}>
                    {result.decision.classification.replace("_", " ")}
                  </Badge>
                </div>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Confidence</span>
                <div className="mt-1 text-lg font-mono font-semibold">
                  {(result.decision.confidence * 100).toFixed(0)}%
                </div>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Urgency</span>
                <div className="mt-1">
                  <Badge className={urgencyColors[result.decision.urgency] ?? ""}>
                    {result.decision.urgency}
                  </Badge>
                </div>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Sentiment</span>
                <div className="mt-1">
                  <Badge variant="outline">
                    {result.decision.sentiment_update ?? "—"}
                  </Badge>
                </div>
              </div>
            </div>

            <Separator />

            {/* Title */}
            {result.decision.title && (
              <div>
                <span className="text-xs text-muted-foreground">Title</span>
                <p className="mt-1 font-medium">{result.decision.title}</p>
              </div>
            )}

            {/* Detail */}
            {result.decision.detail && (
              <div>
                <span className="text-xs text-muted-foreground">Detail</span>
                <p className="mt-1 text-sm">{result.decision.detail}</p>
              </div>
            )}

            {/* Actions */}
            <div>
              <span className="text-xs text-muted-foreground">Actions</span>
              <div className="mt-1 flex flex-wrap gap-2">
                {result.decision.actions.map((action, i) => (
                  <Badge key={i} variant="secondary">
                    {action.type.replace("_", " ")}
                  </Badge>
                ))}
              </div>
            </div>

            <Separator />

            {/* Reasoning */}
            <div>
              <span className="text-xs text-muted-foreground">Reasoning</span>
              <p className="mt-1 text-sm leading-relaxed">
                {result.decision.reasoning}
              </p>
            </div>

            {/* Match info */}
            <div className="flex gap-4 text-xs text-muted-foreground">
              {result.match_method && (
                <span>Match: {result.match_method}</span>
              )}
              {result.customer_name && (
                <span>Customer: {result.customer_name}</span>
              )}
              {result.feedback_id && (
                <span>Feedback: {result.feedback_id.slice(0, 8)}...</span>
              )}
            </div>

            {/* Mode notice */}
            {result.status === "dry_run" && (
              <p className="text-xs text-muted-foreground italic">
                Dry run — no Linear issue created, no state updated. Toggle to
                &quot;live mode&quot; to execute.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* No signal result */}
      {result && result.decision && result.decision.classification === "none" && (
        <Card className="border-gray-200">
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              No actionable signal detected. Context updated only.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
