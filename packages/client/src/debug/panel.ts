/**
 * `debug/panel.ts` — `C-06`'s overlay, the part that draws.
 *
 * The two halves with logic in them shipped on 2026-08-17 (`frametimes.ts`,
 * `tuning.ts`, 37 tests). This is the chrome that was left: putting the numbers
 * on screen, the collision boxes over the world, and the nav graph under it.
 *
 * ## What it headlines, and why not FPS
 *
 * **The 1% low, not the mean.** 59 frames at 10 ms and one at 200 ms averages a
 * comfortable 90 fps while the player feels a hitch every second. `C-04`'s
 * *"60 fps"* done-when means the **1% low** is 60 — a *mean* of 60 is
 * consistent with a third of frames missing the deadline.
 *
 * And the 1% low is not `p99`: `p99Ms` is the value 99% of frames fall *below*,
 * while the 1% low averages the 1% *above*. With 99 frames at 10 ms and one
 * 200 ms stall, `p99Ms` is 10 ms — so deriving one from the other reported a
 * serene 100 fps for a game hitching once a second. `frametimes.ts` computes
 * both separately; this shows both, labelled.
 *
 * ## The cull ratio is labelled honestly
 *
 * Only **3 of the 9 layers** increment their counters — cars, traffic and
 * pickups (plus particles now). `C-04`'s own note says to label that on screen
 * or it reads as more than it is, so the line says which layers it covers
 * rather than implying the whole scene.
 *
 * ## Sliders are not live, deliberately
 *
 * `CarTuning` converts per-second to per-tick **once at load**, and `B-08`'s
 * validator replays against the tuning compiled into the Worker, not whatever
 * the client had in memory. So the flow is **read → JSON → paste into `car.ts`
 * → reload**, which is what the brief's "copy-pasteable JSON blob" described.
 * `tuning.ts` owns that round-trip; the panel prints the blob.
 */
import { type FrameStats, type Layer } from '../render/scene.js';
import { Ink } from '../render/palette.js';
import { type PaperContext } from '../render/paper.js';

import { BUDGET_60_MS, type FrameSummary } from './frametimes.js';

/** The 2D operations the panel needs. */
export interface PanelContext extends PaperContext {
  globalAlpha: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  fillText(text: string, x: number, y: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
}

export interface PanelViewport {
  readonly width: number;
  readonly height: number;
}

/** Everything the panel reports. Assembled by `main.ts`, never gathered here. */
export interface PanelInput {
  readonly frames: FrameSummary;
  /** Histogram buckets from `FrameTimes.histogram()`, and their width in ms. */
  readonly histogram: Int32Array;
  readonly bucketMs: number;
  readonly stats: FrameStats;
  readonly tick: number;
  readonly worldHash: number;
  readonly particles: { readonly alive: number; readonly capacity: number };
  readonly ground: {
    readonly bytes: number;
    readonly budget: number;
    readonly overBudget: boolean;
  } | null;
  /**
   * Phase 6. `null` until `M-04` exists.
   *
   * Present in the type from the start so the panel's shape does not change
   * when netcode lands — and so the absence reads as "not yet" on screen rather
   * than as a section someone forgot.
   */
  readonly net: {
    readonly rttMs: number;
    readonly jitterMs: number;
    readonly predictionError: number;
    readonly bufferDepth: number;
    readonly ticksReplayed: number;
  } | null;
}

const PAD = 10;
const LINE = 14;

/** Layers that actually count. See the note at the top. */
const COUNTING_LAYERS: readonly Layer[] = ['cars', 'traffic', 'pickups', 'particles'];

function fmt(n: number, dp = 1): string {
  return Number.isFinite(n) ? n.toFixed(dp) : '—';
}

/**
 * Draw the panel. Screen space, so call it outside the camera transform.
 *
 * Returns nothing and reads nothing global: everything on screen came in
 * through {@link PanelInput}, so the panel cannot disagree with the frame it is
 * describing.
 */
export function renderPanel(
  context: PanelContext,
  viewport: PanelViewport,
  input: PanelInput,
): void {
  const lines = buildLines(input);
  // Narrow enough to leave the game visible on a small window, but never wider
  // than the window itself — the panel is a tool, not a takeover.
  const width = Math.min(268, viewport.width - PAD * 2);
  const height = PAD * 2 + lines.length * LINE + 26;

  context.save();
  context.globalAlpha = 0.9;
  context.fillStyle = Ink.paperLit;
  context.fillRect(PAD, PAD, width, height);
  context.globalAlpha = 1;
  context.strokeStyle = Ink.graphiteShadow;
  context.lineWidth = 1;
  context.setLineDash([]);
  context.strokeRect(PAD, PAD, width, height);

  context.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
  context.textAlign = 'left';
  context.textBaseline = 'top';

  let y = PAD * 2;
  for (const line of lines) {
    // A line that starts with '!' is a warning and gets the accent. Cheap, and
    // it means a budget overrun cannot hide in a wall of grey monospace.
    const warn = line.startsWith('!');
    context.fillStyle = warn ? Ink.crane : Ink.graphite;
    context.fillText(warn ? line.slice(1) : line, PAD * 2, y);
    y += LINE;
  }

  drawHistogram(context, PAD * 2, y + 6, width - PAD * 2, 18, input.histogram, input.bucketMs);
  context.restore();
}

function buildLines(input: PanelInput): string[] {
  const { frames, stats } = input;

  let considered = 0;
  let drawn = 0;
  for (const layer of COUNTING_LAYERS) {
    considered += stats[layer].considered;
    drawn += stats[layer].drawn;
  }
  const ratio = considered > 0 ? drawn / considered : 0;

  // `settled` gates the headline, and `frametimes.ts` is explicit that the
  // overlay MUST show a dash rather than a number when it is false: below 100
  // samples the "worst 1%" is one frame, and the first frame after load is
  // always slow. Without this the number stared at all day is noise for the
  // first second of every run.
  const low = frames.settled ? `${fmt(frames.lowOnePercentFps)} fps` : '— (settling)';

  const lines = [
    `tick ${input.tick}   hash ${(input.worldHash >>> 0).toString(16).padStart(8, '0')}`,
    '',
    // The headline. 1% low first because it is the one the done-when means.
    `1% low   ${low}`,
    `p99      ${fmt(frames.p99Ms, 2)} ms   <- 99% fall BELOW this`,
    `p50/max  ${fmt(frames.p50Ms, 2)} / ${fmt(frames.maxMs, 2)} ms`,
    `mean     ${fmt(frames.meanFps)} fps  (${fmt(frames.meanMs, 2)} ms)`,
    `${frames.missedFraction > 0 ? '!' : ''}missed 60Hz  ${(frames.missedFraction * 100).toFixed(1)}%  (n=${frames.count})`,
    '',
    `draws ${drawn}/${considered}  cull ${(ratio * 100).toFixed(0)}% kept`,
    `  (cars, traffic, pickups, particles only)`,
    `particles ${input.particles.alive}/${input.particles.capacity}`,
  ];

  if (input.ground !== null) {
    const mb = (b: number): string => (b / (1024 * 1024)).toFixed(1);
    const over = input.ground.overBudget ? '!' : '';
    lines.push(
      `${over}ground ${mb(input.ground.bytes)}/${mb(input.ground.budget)} MB${input.ground.overBudget ? '  OVER' : ''}`,
    );
  }

  lines.push('');
  if (input.net === null) {
    lines.push('net  — (M-04)');
  } else {
    lines.push(
      `net  rtt ${fmt(input.net.rttMs, 0)}ms  jit ${fmt(input.net.jitterMs, 0)}ms`,
      `     err ${fmt(input.net.predictionError, 2)}  buf ${input.net.bufferDepth}`,
      `     replayed ${input.net.ticksReplayed}`,
    );
  }

  return lines;
}

/**
 * The frame-time histogram.
 *
 * A shape, not numbers: the thing you look for is a second cluster out to the
 * right, which is a hitch pattern and is invisible in any single statistic.
 */
function drawHistogram(
  context: PanelContext,
  x: number,
  y: number,
  width: number,
  height: number,
  buckets: Int32Array,
  bucketMs: number,
): void {
  if (buckets.length === 0) return;

  let peak = 0;
  for (const count of buckets) peak = Math.max(peak, count);
  if (peak === 0) return;

  const barWidth = width / buckets.length;
  for (let i = 0; i < buckets.length; i += 1) {
    const count = buckets[i] ?? 0;
    if (count === 0) continue;
    const h = Math.max(1, Math.round((count / peak) * height));
    // Buckets past the 60 fps deadline are the interesting ones.
    context.fillStyle = i * bucketMs >= BUDGET_60_MS ? Ink.crane : Ink.graphiteSoft;
    context.fillRect(x + i * barWidth, y + height - h, Math.max(1, barWidth - 1), h);
  }
}

/**
 * Collision boxes, in **world** space — call inside the camera transform.
 *
 * Draws the cab's own AABB and the buildings it is tested against. This is the
 * view that makes a depenetration bug (ADR 0007) obvious: the box either
 * overlaps or it does not, and no amount of staring at the art tells you.
 */
export function drawCollisionBoxes(
  context: PanelContext,
  boxes: readonly { minX: number; minY: number; maxX: number; maxY: number }[],
): void {
  context.save();
  context.strokeStyle = Ink.crane;
  context.lineWidth = 0.08;
  context.setLineDash([0.4, 0.3]);
  for (const b of boxes) {
    context.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
  }
  context.restore();
}

/**
 * The nav graph, in **world** space.
 *
 * The thing `W-04`'s traffic actually drives on, drawn over the thing the
 * player sees. When a vehicle behaves oddly this is the first place to look —
 * the art and the graph are separate artefacts and can disagree.
 */
export function drawNavGraph(
  context: PanelContext,
  nodes: readonly { x: number; y: number }[],
  edges: readonly { a: number; b: number }[],
): void {
  context.save();
  context.strokeStyle = Ink.crease;
  context.lineWidth = 0.12;
  context.setLineDash([]);
  context.beginPath();
  for (const edge of edges) {
    const a = nodes[edge.a];
    const b = nodes[edge.b];
    if (a === undefined || b === undefined) continue;
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
  }
  context.stroke();

  context.fillStyle = Ink.crease;
  for (const node of nodes) context.fillRect(node.x - 0.4, node.y - 0.4, 0.8, 0.8);
  context.restore();
}
