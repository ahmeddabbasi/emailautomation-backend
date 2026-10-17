// Pure display-label constants, safe to import from both client and server
// components. Data-fetching logic lives in data.ts (server-only) instead.
import type { SequenceStep } from "@/lib/types";

// Follow-up offsets are configurable per list, so steps are named by
// position rather than by a fixed day.
export const SEQUENCE_STEP_LABELS: Record<SequenceStep, string> = {
  0: "Initial",
  1: "Follow-up 1",
  2: "Follow-up 2",
  3: "Follow-up 3",
};

export const CONTACT_STATUS_LABELS = {
  queued: "Queued",
  pending: "Active",
  stopped: "Stopped",
  invalid: "Invalid",
  completed: "Completed",
  generation_failed: "Generation failed",
  replied: "Replied",
  complained: "Complained",
  unsubscribed: "Unsubscribed",
} as const;

export const ACTIVE_DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
