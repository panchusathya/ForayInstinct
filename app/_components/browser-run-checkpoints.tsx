"use client";

import { RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type BrowserRunCheckpoint = {
  action: string | null;
  actions: string[];
  attempt: number;
  createdAt: string;
  errorCode: string | null;
  page: string | null;
  phase: string;
  sessionId: string;
  state: string | null;
  trace: string[];
};

export function BrowserRunCheckpoints() {
  const [checkpoints, setCheckpoints] = useState<BrowserRunCheckpoint[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch("/api/browser-runs", { cache: "no-store" });
      if (!response.ok)
        throw new Error("Browser checkpoints could not be loaded.");
      const body = (await response.json()) as {
        checkpoints: BrowserRunCheckpoint[];
      };
      setCheckpoints(body.checkpoints);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Browser checkpoints could not be loaded."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section aria-labelledby="browser-checkpoints-heading">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle id="browser-checkpoints-heading">
                Browser checkpoints
              </CardTitle>
              <CardDescription>
                Durable, redacted routing and recovery history.
              </CardDescription>
            </div>
            <Button
              disabled={loading}
              onClick={() => void load()}
              size="sm"
              type="button"
              variant="outline"
            >
              <RefreshCwIcon className={loading ? "animate-spin" : undefined} />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {error ? (
            <p className="text-destructive type-supporting-body">{error}</p>
          ) : null}
          {!error && checkpoints.length === 0 && !loading ? (
            <p className="text-muted-foreground type-supporting-body">
              Browser activity will appear here after a run starts.
            </p>
          ) : null}
          <ol className="grid gap-3">
            {checkpoints.slice(0, 30).map((checkpoint) => (
              <li
                className="rounded-lg border border-border/70 p-3"
                key={`${checkpoint.sessionId}-${checkpoint.createdAt}-${checkpoint.phase}-${String(checkpoint.attempt)}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant={checkpoint.errorCode ? "destructive" : "outline"}
                  >
                    {checkpoint.phase}
                  </Badge>
                  {checkpoint.state ? (
                    <span className="type-label">{checkpoint.state}</span>
                  ) : null}
                  {checkpoint.attempt > 0 ? (
                    <span className="text-muted-foreground type-caption">
                      attempt {String(checkpoint.attempt)}
                    </span>
                  ) : null}
                </div>
                <p className="mt-2 break-all text-muted-foreground type-caption">
                  {checkpoint.page ?? checkpoint.sessionId}
                </p>
                {checkpoint.trace.length > 0 ? (
                  <p className="mt-1 text-muted-foreground type-caption">
                    {checkpoint.trace.join(" → ")}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </section>
  );
}
