/**
 * Deterministic forward forecast for the pumpfun top-five competition.
 * Historical trajectories inform drift, volatility and survival; seeded
 * Monte Carlo simulations turn those estimates into rank and cap-bin shares.
 */
import * as fs from "node:fs";
import * as path from "node:path";

type Row = {
  mint: string; rank: number; logCap: number; venue: string;
  quoteSOL: number; complete: boolean; mayhem: boolean; createdAt: number;
};
type Mark = { at: number; rows: Row[] };
type Point = { index: number; time: number; logCap: number; rank: number };
type Candidate = {
  mint: string; points: Point[]; first: number; last: number;
  lastLogCap: number; lastRank: number; lastVenue: string; quoteSOL: number;
  complete: boolean; mayhem: boolean; createdAt: number;
  driftRecent: number; driftAll: number; volPerHour: number;
  presenceShare: number; peak: number; drop: number; ageHours: number;
  drift: number; lambda: number;
};

const clamp = (x: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, x));
const log10 = (x: number): number => Math.log(x) / Math.LN10;

function parseTime(value: unknown): number {
  const t = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : NaN;
}

function capLog(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  try {
    const n = BigInt(value);
    if (n <= 0n) return null;
    return log10(Number(n)) - 9;
  } catch { return null; }
}

function readInput(dir: string): { task: any; marks: Mark[] } {
  const task = JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8"));
  const lines = fs.readFileSync(path.join(dir, "history.ndjson"), "utf8").split(/\r?\n/);
  const marks: Mark[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line);
      if (raw?.ok !== true || !Array.isArray(raw.rows)) continue;
      const at = parseTime(raw.at);
      if (!Number.isFinite(at)) continue;
      const rows: Row[] = [];
      for (const r of raw.rows) {
        const cap = capLog(r?.market_cap_lamports);
        if (cap === null || typeof r?.mint !== "string" || !r.mint) continue;
        let quoteSOL = 0;
        if (typeof r.quote_reserves_lamports === "string" && /^\d+$/.test(r.quote_reserves_lamports)) {
          try { quoteSOL = Number(BigInt(r.quote_reserves_lamports)) / 1e9; } catch { quoteSOL = 0; }
        }
        rows.push({
          mint: r.mint, rank: Number.isFinite(Number(r.rank)) ? Number(r.rank) : 999,
          logCap: cap, venue: String(r.venue ?? ""), quoteSOL,
          complete: r.complete === true, mayhem: r.mayhem === true,
          createdAt: parseTime(r.created_at),
        });
      }
      rows.sort((a, b) => a.rank - b.rank || a.mint.localeCompare(b.mint));
      marks.push({ at, rows });
    } catch { /* Ignore malformed lines. */ }
  }
  marks.sort((a, b) => a.at - b.at);
  return { task, marks };
}

function slope(points: Point[], indices?: number[]): number {
  const chosen = indices ? indices.map(i => points[i]).filter(Boolean) : points;
  if (chosen.length < 2) return 0;
  const origin = chosen[0].time;
  const xs = chosen.map(p => (p.time - origin) / 3600000);
  const ys = chosen.map(p => p.logCap);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den > 1e-9 ? num / den : 0;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  const m = values.length >> 1;
  return values.length % 2 ? values[m] : (values[m - 1] + values[m]) / 2;
}

function populationDrift(marks: Mark[]): number {
  const shifts: number[] = [];
  for (let i = 1; i < marks.length; i++) {
    const later = new Map(marks[i].rows.map(r => [r.mint, r.logCap]));
    const changes: number[] = [];
    for (const r of marks[i - 1].rows) {
      const next = later.get(r.mint);
      if (r.rank <= 30 && next !== undefined) changes.push(next - r.logCap);
    }
    if (changes.length) {
      const hours = (marks[i].at - marks[i - 1].at) / 3600000;
      if (hours > 0) shifts.push(median(changes) / hours);
    }
  }
  return shifts.length ? shifts.reduce((a, b) => a + b, 0) / shifts.length : -0.04;
}

function buildCandidates(marks: Mark[]): Candidate[] {
  const series = new Map<string, Point[]>();
  const rowsByMint = new Map<string, Row[]>();
  for (let i = 0; i < marks.length; i++) for (const r of marks[i].rows) {
    const points = series.get(r.mint) ?? [];
    points.push({ index: i, time: marks[i].at, logCap: r.logCap, rank: r.rank });
    series.set(r.mint, points);
    const rr = rowsByMint.get(r.mint) ?? [];
    rr.push(r); rowsByMint.set(r.mint, rr);
  }
  const cut = marks.length - 1;
  const cutRows = marks[cut]?.rows ?? [];
  const recentStart = Math.max(0, marks.length - Math.max(2, Math.ceil(marks.length / 3)));
  const scored = [...series.entries()].map(([mint, points]) => {
    const rows = rowsByMint.get(mint)!;
    const lastPoint = points[points.length - 1];
    const recent = points.filter(p => p.index >= recentStart);
    const changes: number[] = [];
    for (let i = 1; i < points.length; i++)
      if (points[i].index === points[i - 1].index + 1)
        changes.push(points[i].logCap - points[i - 1].logCap);
    const mean = changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : 0;
    const vol = changes.length > 1
      ? Math.sqrt(changes.reduce((s, x) => s + (x - mean) ** 2, 0) / (changes.length - 1)) * Math.sqrt(6)
      : NaN;
    const first = points[0].index;
    const present = points.length / (cut - first + 1);
    const peak = Math.max(...points.map(p => p.logCap));
    const row = rows[rows.length - 1];
    const created = Number.isFinite(row.createdAt) ? row.createdAt : NaN;
    return {
      mint, points, first, last: lastPoint.index, lastLogCap: lastPoint.logCap,
      lastRank: lastPoint.rank, lastVenue: row.venue, quoteSOL: row.quoteSOL,
      complete: row.complete, mayhem: row.mayhem, createdAt: created,
      driftRecent: slope(recent), driftAll: slope(points), volPerHour: vol,
      presenceShare: present, peak, drop: peak - lastPoint.logCap,
      ageHours: Number.isFinite(created) ? Math.max(0, (marks[cut].at - created) / 3600000) : 0,
      drift: 0, lambda: 0,
    } as Candidate;
  });
  const always = new Set(cutRows.filter(r => r.rank <= 40).map(r => r.mint));
  scored.sort((a, b) => {
    const aa = a.last === cut ? 1 : 0, bb = b.last === cut ? 1 : 0;
    const presenceA = a.points.filter(p => p.index >= recentStart).length;
    const presenceB = b.points.filter(p => p.index >= recentStart).length;
    return bb - aa || b.lastLogCap - a.lastLogCap || a.lastRank - b.lastRank ||
      presenceB - presenceA || a.mint.localeCompare(b.mint);
  });
  const chosen = scored.slice(0, 140);
  for (const c of scored) if (always.has(c.mint) && !chosen.includes(c)) chosen.push(c);
  const pop = populationDrift(marks);
  for (const c of chosen) {
    const raw = clamp(0.6 * c.driftRecent + 0.4 * c.driftAll, pop - 0.30, pop + 0.45);
    c.drift = pop + 0.7 * (raw - pop);
    let lambda = 0.012;
    if (c.lastVenue === "curve") lambda *= 2.2;
    if (!c.complete) lambda *= 1.5;
    if (c.quoteSOL < 30) lambda *= 1.6;
    if (c.lastVenue === "pool") lambda *= 0.45;
    if (c.drop > 0.7) lambda *= 1.5;
    if (c.presenceShare > 0.9) lambda *= 0.7;
    c.lambda = lambda;
  }
  return chosen;
}

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalGenerator(random: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) { const v = spare; spare = null; return v; }
    let u = 0, v = 0;
    while (u === 0) u = random();
    v = random();
    const mag = Math.sqrt(-2 * Math.log(u));
    spare = mag * Math.sin(2 * Math.PI * v);
    return mag * Math.cos(2 * Math.PI * v);
  };
}

function binFor(value: number, edges: number[]): number {
  if (value < edges[0]) return 0;
  for (let i = 1; i < edges.length; i++) if (value < edges[i]) return i;
  return edges.length;
}

function floor6(p: number): number {
  return Math.floor(Math.max(0, p) * 1e6) / 1e6;
}

function forecast(task: any, marks: Mark[]): any {
  const seen = [...new Set(marks.flatMap(m => m.rows.map(r => r.mint)))];
  const top5: string[] = [];
  const lastRows = marks[marks.length - 1]?.rows ?? [];
  const candidates = marks.length ? buildCandidates(marks) : [];
  const candidateMints = new Set(candidates.map(c => c.mint));
  for (const r of lastRows) if (!top5.includes(r.mint) && top5.length < 5) top5.push(r.mint);
  for (const mint of seen) if (!top5.includes(mint) && top5.length < 5) top5.push(mint);
  while (top5.length < 5 && lastRows.length) {
    const mint = lastRows.find(r => !top5.includes(r.mint))?.mint;
    if (!mint) break;
    top5.push(mint);
  }
  if (!marks.length || !candidates.length) return { probabilities: [], top5, sizes: [] };

  const cutTime = marks[marks.length - 1].at;
  const reads = Array.isArray(task.reads) ? task.reads : [];
  const horizons = reads.map((r: unknown) => {
    const time = parseTime(r);
    return Number.isFinite(time) ? Math.max(0.05, (time - cutTime) / 3600000) : 0.05;
  });
  if (!horizons.length) horizons.push(0.05);
  const edges: number[] = Array.isArray(task.size?.edges)
    ? task.size.edges.map(Number).filter(Number.isFinite) : [];
  if (!edges.length) for (let i = 0; i < 81; i++) edges.push(2 + i * 0.05);

  const nSims = 2500;
  const placeCounts = Array.from({ length: 5 }, () => new Map<string, number>());
  const sizeCounts = Array.from({ length: 5 }, () => new Array(82).fill(0));
  const random = makeRandom(0x51A7C0DE);
  const normal = normalGenerator(random);
  let total = 0;
  for (const h of horizons) {
    const simulated: { mint: string; cap: number }[] = [];
    for (let s = 0; s < nSims; s++) {
      simulated.length = 0;
      for (const c of candidates) {
        const vol = Number.isFinite(c.volPerHour) ? c.volPerHour : 0.45;
        const sd = clamp(vol * Math.sqrt(h), 0.18, 1.15);
        let cap = c.lastLogCap + c.drift * h + normal() * sd;
        if (random() < 1 - Math.exp(-c.lambda * h)) cap -= 2.6;
        simulated.push({ mint: c.mint, cap });
      }
      simulated.sort((a, b) => b.cap - a.cap || a.mint.localeCompare(b.mint));
      for (let p = 0; p < 5 && p < simulated.length; p++) {
        const winner = simulated[p];
        const map = placeCounts[p];
        map.set(winner.mint, (map.get(winner.mint) ?? 0) + 1);
        sizeCounts[p][binFor(winner.cap, edges)]++;
      }
      total++;
    }
  }
  const reserves = [0.10, 0.13, 0.16, 0.19, 0.22];
  const probabilities: { mint: string; place: number; p: number }[] = [];
  for (let place = 0; place < 5; place++) {
    const ranked = [...placeCounts[place]].map(([mint, count]) => ({
      mint, p: floor6((1 - reserves[place]) * count / total),
    })).filter(item => item.p > 0)
      .sort((a, b) => b.p - a.p || a.mint.localeCompare(b.mint));
    // The output format permits at most 100 named rows for each place.
    for (const item of ranked.slice(0, 100))
      probabilities.push({ mint: item.mint, place: place + 1, p: item.p });
  }
  // Retain a small, nonzero tail for plausible candidates that did not win a
  // sampled place; this also prevents Monte Carlo sparsity from hiding them.
  for (let place = 1; place <= 5 && probabilities.length < 140; place++) {
    const named = new Set(probabilities.filter(r => r.place === place).map(r => r.mint));
    for (const c of candidates) {
      if (probabilities.length >= 140) break;
      if (!named.has(c.mint) && probabilities.filter(r => r.place === place).length < 100) {
        probabilities.push({ mint: c.mint, place, p: 0.000001 });
        named.add(c.mint);
      }
    }
  }
  probabilities.sort((a, b) => a.place - b.place || b.p - a.p || a.mint.localeCompare(b.mint));
  for (let place = 1; place <= 5; place++) {
    let sum = probabilities.filter(r => r.place === place).reduce((a, r) => a + r.p, 0);
    if (sum > 1) {
      const rows = probabilities.filter(r => r.place === place).sort((a, b) => a.p - b.p || b.mint.localeCompare(a.mint));
      while (sum > 1 && rows.length) sum -= rows.shift()!.p;
      const keep = new Set(rows);
      for (let i = probabilities.length - 1; i >= 0; i--)
        if (probabilities[i].place === place && !keep.has(probabilities[i])) probabilities.splice(i, 1);
    }
  }

  const sizes: { place: number; bin: number; p: number }[] = [];
  for (let place = 0; place < 5; place++) {
    const hist = sizeCounts[place];
    const smooth = hist.map((_, i) => 0.25 * (hist[i - 1] ?? 0) + 0.5 * hist[i] + 0.25 * (hist[i + 1] ?? 0));
    const mass = smooth.reduce((a, b) => a + b, 0);
    const placeBins: { bin: number; raw: number; p: number }[] = [];
    for (let b = 0; b < 82; b++) {
      const raw = 0.97 * (0.98 * (mass ? smooth[b] / mass : 0) + 0.02 / 82);
      placeBins.push({ bin: b, raw, p: floor6(raw) });
    }
    // Flooring each bin loses up to one micro-unit per bin; restore that
    // mass to the largest bins so every place keeps the intended 0.97 total.
    let leftover = 0.97 - placeBins.reduce((sum, item) => sum + item.p, 0);
    const largestFirst = [...placeBins].sort((a, b) => b.raw - a.raw || a.bin - b.bin);
    for (const item of largestFirst) {
      if (leftover < 1e-6 - 1e-12) break;
      const add = Math.min(leftover, 1 - item.p);
      const updated = floor6(item.p + add);
      leftover -= updated - item.p;
      item.p = updated;
    }
    // Put any sub-micro rounding residue on the largest eligible bin.
    if (leftover > 0) {
      const target = largestFirst.find(item => item.p + leftover <= 1 + 1e-12);
      if (target) target.p = Math.min(1, target.p + leftover);
    }
    for (const item of placeBins) if (item.p > 0)
      sizes.push({ place: place + 1, bin: item.bin, p: item.p });
  }
  sizes.sort((a, b) => a.place - b.place || a.bin - b.bin);

  const rankedFallback = [...lastRows.map(r => r.mint), ...candidates.map(c => c.mint)];
  const used = new Set<string>();
  const greedy: string[] = [];
  for (let place = 1; place <= 5; place++) {
    const best = probabilities
      .filter(r => r.place === place && !used.has(r.mint))
      .sort((a, b) => b.p - a.p || a.mint.localeCompare(b.mint))[0];
    let mint = best?.mint;
    if (!mint) mint = rankedFallback.find(m => !used.has(m));
    if (mint) { greedy.push(mint); used.add(mint); }
  }
  top5.splice(0, top5.length, ...greedy);
  return { probabilities, top5, sizes };
}

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR || "/input";
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
  let output = "forecast.json";
  let value: any = { probabilities: [], top5: [], sizes: [] };
  try {
    const { task, marks } = readInput(inputDir);
    if (typeof task.output === "string" && task.output) output = task.output;
    value = forecast(task, marks);
  } catch { /* Emit a valid empty forecast if input is unavailable or malformed. */ }
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, output), JSON.stringify(value) + "\n", "utf8");
}

main();
