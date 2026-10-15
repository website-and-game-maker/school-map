// The shared pool behind crowd-sourced walking times
// (westlake-map/src/lib/timing.ts). A Vercel serverless function, deployed
// with the rest of the repo by vercel.json; storage is any Redis that speaks
// the Upstash REST API (Vercel's "Upstash for Redis" integration sets the two
// variables below for you).
//
//   GET  /api/timings  → { reports: TimingReport[] }   newest first, up to 2000
//   POST /api/timings  ← one TimingReport as JSON      → 204, or 400 if implausible
//
// The app only calls this when built with VITE_TIMING_ENDPOINT pointing here.
// Without storage configured it answers 503 and the app quietly keeps timings
// on each device instead.

const URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = "westlake-map:timings";
const KEEP = 2000;

async function redis(commands) {
  const res = await fetch(`${URL}/pipeline`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`redis ${res.status}`);
  return res.json();
}

// The same plausibility rules as rejectReason() in lib/timing.ts: anything
// else is a forgotten timer, a mis-tap or junk, and would skew everyone's map.
export function clean(body) {
  if (!body || typeof body !== "object") return null;
  const { from, to, feet, flights, seconds, at } = body;
  const num = (v) => typeof v === "number" && Number.isFinite(v);
  if (typeof from !== "string" || typeof to !== "string") return null;
  if (!from || !to || from.length > 64 || to.length > 64) return null;
  if (!num(feet) || !num(flights) || !num(seconds) || !num(at)) return null;
  if (feet <= 0 || feet > 5000 || flights < 0 || flights > 4) return null;
  if (seconds < 10 || seconds > 20 * 60) return null;
  const pace = feet / Math.max(seconds - flights * 25, 1);
  if (pace < 1 || pace > 10) return null;
  // A report from the future, or from long ago, is a wrong clock: use ours.
  const now = Date.now();
  const when = Math.abs(now - at) < 24 * 3600e3 ? at : now;
  return { from, to, feet: Math.round(feet), flights: Math.round(flights), seconds: Math.round(seconds), at: when };
}

export default async function handler(req, res) {
  // The app is served from GitHub Pages, a different origin.
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!URL || !TOKEN) return res.status(503).json({ error: "timing storage not configured" });

  try {
    if (req.method === "GET") {
      const [{ result }] = await redis([["LRANGE", KEY, 0, KEEP - 1]]);
      const reports = (result || []).map((s) => {
        try {
          return JSON.parse(s);
        } catch {
          return null;
        }
      }).filter(Boolean);
      res.setHeader("cache-control", "public, max-age=60");
      return res.status(200).json({ reports });
    }
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "null") : req.body;
      const report = clean(body);
      if (!report) return res.status(400).json({ error: "implausible walk" });
      await redis([
        ["LPUSH", KEY, JSON.stringify(report)],
        ["LTRIM", KEY, 0, KEEP - 1],
      ]);
      return res.status(204).end();
    }
    return res.status(405).json({ error: "GET or POST" });
  } catch {
    return res.status(502).json({ error: "storage unavailable" });
  }
}
