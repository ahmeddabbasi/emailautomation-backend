export function createRateLimiter(limit: number, windowMs: number, now: () => number = () => Date.now()) {
  const hits = new Map<string, number[]>();
  return {
    allow(key: string): boolean {
      const time = now();
      const recent = (hits.get(key) ?? []).filter((stamp) => time - stamp < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(time);
      hits.set(key, recent);
      return true;
    },
  };
}

// One shared login, so drafts are limited for the whole workspace.
export const draftRateLimit = createRateLimiter(8, 60_000);
