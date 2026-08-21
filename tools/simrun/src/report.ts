/**
 * `report.ts` — what a city looks like while it is being played.
 *
 * `W-04`'s done-when is *"a headless 180 s run shows traffic density inside
 * target bounds on every road segment and demand visibly moving between
 * districts"*. This is the instrument that decides it.
 *
 * Two measurements, both of which need saying carefully.
 *
 * ## Traffic: the two failures are opposite, so one number cannot see both
 *
 * "No pile-ups, no empty streets" is a statement about the *distribution*, not
 * the mean. Twenty-four vehicles on two hundred and thirty roads averages 0.1
 * per road whether they are spread evenly or all sitting in one junction — the
 * mean is identical in the healthy case and the broken one.
 *
 * So this reports **coverage** (what fraction of roads ever saw a vehicle) and
 * **peak occupancy** (the most that were ever on one road at once) separately.
 * Coverage catches dead streets; peak catches pile-ups; the average catches
 * neither.
 *
 * ## Demand: migration is a claim about *change*, not about where demand is
 *
 * A snapshot of where passengers are spawning says nothing about whether the
 * field is moving — a static hotspot and a migrating one look the same at any
 * single moment. So the run is split into quarters and the per-district share
 * is reported for each, which makes movement visible as the thing it is: a
 * district's share rising and another's falling.
 */
import {
  MAX_PASSENGERS,
  MAX_TRAFFIC,
  Passenger,
  Traffic,
  FX_ONE,
  getPassenger,
  getTraffic,
  isPassengerActive,
  isTrafficActive,
  step,
  type RuntimeCity,
  type World,
} from '@deadhead/sim';

/** The four quarters of a city, named by the compass. */
export type District = 'NW' | 'NE' | 'SW' | 'SE';

const DISTRICTS: readonly District[] = ['NW', 'NE', 'SW', 'SE'];

function districtOf(x: number, y: number): District {
  return `${y < 0 ? 'N' : 'S'}${x < 0 ? 'W' : 'E'}` as District;
}

export interface TrafficReport {
  readonly roads: number;
  /** Roads that carried a vehicle at least once, as a fraction. */
  readonly coverage: number;
  /** Most vehicles seen on a single road in one tick. */
  readonly peakOnOneRoad: number;
  /** Mean vehicles per road, over roads that were used at all. */
  readonly meanOnUsedRoads: number;
  /** Roads never visited, worst-covered first. */
  readonly deadRoads: number;
  /** Fraction of ticks a vehicle spent below walking pace — a pile-up proxy. */
  readonly stalledFraction: number;
}

export interface DemandReport {
  /** Per-quarter share of spawns, one row per quarter of the run. */
  readonly shares: readonly (readonly [District, readonly number[]])[];
  /** Total spawns observed. */
  readonly spawns: number;
  /**
   * How far the busiest district's share travelled over the run.
   *
   * The single number that answers "is demand migrating". Zero means a static
   * field; the anchors in `W-03` are phased to make this large.
   */
  readonly migration: number;
}

export interface RunReport {
  readonly ticks: number;
  readonly traffic: TrafficReport;
  readonly demand: DemandReport;
}

/**
 * Run a city and measure it.
 *
 * Takes the input for each tick from `drive`, so the caller decides whether a
 * bot is at the wheel or nobody is. Traffic and demand are both properties of
 * the *city* rather than of the driver, so an idle run is a valid measurement —
 * but a driven one exercises the demand field the way a player does.
 */
export function measureRun(
  world: World,
  city: RuntimeCity,
  ticks: number,
  drive: (world: World) => number,
): RunReport {
  const roadCount = city.packed.edges.length / 4;
  const everUsed = new Uint8Array(roadCount);
  const quarters = ticks / 4;

  let peakOnOneRoad = 0;
  let usedSamples = 0;
  let usedTotal = 0;
  let stalled = 0;
  let vehicleTicks = 0;

  // Spawn counts: [quarter][district]
  const spawnCounts = DISTRICTS.map(() => [0, 0, 0, 0]);
  const seenPassenger = new Set<string>();
  let spawns = 0;

  const perRoad = new Int32Array(roadCount);
  // `Inputs` is a readonly array of packed inputs, one per player.
  const inputs: number[] = [0];

  for (let tick = 0; tick < ticks; tick += 1) {
    inputs[0] = drive(world);
    world = step(world, inputs);

    // --- traffic -----------------------------------------------------------
    perRoad.fill(0);
    let onRoads = 0;
    for (let slot = 0; slot < MAX_TRAFFIC; slot += 1) {
      if (!isTrafficActive(world, slot)) continue;
      vehicleTicks += 1;

      const edge = getTraffic(world, slot, Traffic.Edge);
      if (edge >= 0 && edge < roadCount) {
        perRoad[edge] += 1;
        everUsed[edge] = 1;
        onRoads += 1;
      }
      if (getTraffic(world, slot, Traffic.Speed) < FX_ONE / 8) stalled += 1;
    }
    for (let road = 0; road < roadCount; road += 1) {
      const n = perRoad[road]!;
      if (n > peakOnOneRoad) peakOnOneRoad = n;
    }
    if (onRoads > 0) {
      usedTotal += onRoads;
      usedSamples += 1;
    }

    // --- demand ------------------------------------------------------------
    // Count each passenger once, at the quarter they appeared in.
    const quarter = Math.min(3, Math.floor(tick / quarters));
    for (let slot = 0; slot < MAX_PASSENGERS; slot += 1) {
      if (!isPassengerActive(world, slot)) continue;
      const x = getPassenger(world, slot, Passenger.X) / FX_ONE;
      const y = getPassenger(world, slot, Passenger.Y) / FX_ONE;
      const key = `${slot}:${x}:${y}`;
      if (seenPassenger.has(key)) continue;
      seenPassenger.add(key);
      spawns += 1;
      spawnCounts[DISTRICTS.indexOf(districtOf(x, y))]![quarter] += 1;
    }
  }

  const perQuarterTotals = [0, 1, 2, 3].map((q) =>
    DISTRICTS.reduce((sum, _, d) => sum + spawnCounts[d]![q]!, 0),
  );
  const shares = DISTRICTS.map(
    (name, d) =>
      [
        name,
        [0, 1, 2, 3].map((q) =>
          perQuarterTotals[q]! === 0 ? 0 : spawnCounts[d]![q]! / perQuarterTotals[q]!,
        ),
      ] as const,
  );

  // How far any one district's share travelled across the run.
  const migration = Math.max(...shares.map(([, row]) => Math.max(...row) - Math.min(...row)));

  let used = 0;
  for (const flag of everUsed) if (flag === 1) used += 1;

  return {
    ticks,
    traffic: {
      roads: roadCount,
      coverage: roadCount === 0 ? 0 : used / roadCount,
      peakOnOneRoad,
      meanOnUsedRoads: usedSamples === 0 ? 0 : usedTotal / usedSamples,
      deadRoads: roadCount - used,
      stalledFraction: vehicleTicks === 0 ? 0 : stalled / vehicleTicks,
    },
    demand: { shares, spawns, migration },
  };
}

/** The report as a person reads it. */
export function formatReport(report: RunReport): string {
  const t = report.traffic;
  const lines = [
    `TRAFFIC over ${report.ticks} ticks (${(report.ticks / 30).toFixed(0)} s)`,
    `  roads                ${t.roads}`,
    `  coverage             ${(t.coverage * 100).toFixed(0)}%  (${t.deadRoads} never used)`,
    `  peak on one road     ${t.peakOnOneRoad}`,
    `  mean on the network  ${t.meanOnUsedRoads.toFixed(1)}`,
    `  vehicle-ticks stalled ${(t.stalledFraction * 100).toFixed(1)}%`,
    '',
    `DEMAND — share of spawns per quarter of the run (${report.demand.spawns} spawns)`,
    '           Q1     Q2     Q3     Q4',
  ];
  for (const [name, row] of report.demand.shares) {
    lines.push(`  ${name}   ` + row.map((v) => `${(v * 100).toFixed(0)}%`.padStart(6)).join(' '));
  }
  lines.push('');
  lines.push(
    `  migration            ${(report.demand.migration * 100).toFixed(0)} percentage points ` +
      `(the busiest district's share, high-water to low-water)`,
  );
  return lines.join('\n');
}
