const PING_EVERY_MS = 5 * 60 * 1000;

// Render's free web service sleeps after 15 minutes with no inbound request.
// An internal timer does not count. Calling the public URL does, and 5 minutes
// leaves room for one missed ping before the 15-minute window closes.
const globalForKeepAwake = globalThis as unknown as { keepAwakeStarted?: boolean };

export function startKeepAwake(): void {
  if (globalForKeepAwake.keepAwakeStarted) return;
  const origin = process.env.RENDER_EXTERNAL_URL?.replace(/\/$/, "");
  if (!origin) return;
  globalForKeepAwake.keepAwakeStarted = true;

  const ping = () => {
    fetch(`${origin}/api/health/live`, { cache: "no-store" })
      .then((response) => {
        console.log(`[keep-awake] ${response.status} ${origin}/api/health/live`);
      })
      .catch((err: unknown) => {
        console.log(`[keep-awake] failed ${err instanceof Error ? err.message : "request failed"}`);
      });
  };

  setInterval(ping, PING_EVERY_MS).unref?.();
  ping();
}
