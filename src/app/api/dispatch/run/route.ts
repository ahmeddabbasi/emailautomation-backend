import { NextResponse } from "next/server";
import { runDispatchTick } from "@/lib/dispatch";
import { handleRouteError } from "@/lib/api-helpers";

// A tick paces sends 3s apart and may generate follow-ups, so it can run
// well past the default function timeout.
export const maxDuration = 300;

// Session-protected manual trigger for the same tick the cron runs — lets
// an operator run one now instead of waiting for the next scheduled tick.
export async function POST() {
  try {
    const summary = await runDispatchTick();
    return NextResponse.json(summary);
  } catch (err) {
    return handleRouteError(err, "dispatch");
  }
}
