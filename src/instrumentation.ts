export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.RENDER !== "true") return;

  const { startKeepAwake } = await import("@/lib/keep-awake");
  startKeepAwake();
}
