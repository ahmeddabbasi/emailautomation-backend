const base = (process.env.BACKEND_URL || "").replace(/\/$/, "");
const secret = process.env.CRON_SECRET || "";

if (!base || !secret) {
  console.error("BACKEND_URL and CRON_SECRET are required");
  process.exit(1);
}

const response = await fetch(`${base}/api/cron/dispatch`, {
  method: "POST",
  headers: { Authorization: `Bearer ${secret}` },
});
const body = await response.text();
console.log(response.status, body);
if (!response.ok) process.exit(1);
