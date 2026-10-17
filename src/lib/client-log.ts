"use client";

export interface ClientErrorReport {
  code: string;
  message: string;
  level?: "error" | "warning";
  details?: Record<string, unknown>;
  stack?: string;
}

// Fire-and-forget: reporting an error must never itself throw into the UI.
export function reportClientError(report: ClientErrorReport): void {
  try {
    const body = JSON.stringify({
      ...report,
      details: { ...report.details, page: window.location.pathname },
    });
    fetch("/api/logs/client", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Nothing useful left to do if serialising the report itself failed.
  }
}
