/**
 * `city-01.ts` — Creaseway, City 01.
 *
 * ## The shape, and why
 *
 * `W-03` asks for a city designed for **mastery**: asymmetric blocks, at least
 * four genuine shortcuts, one-way streets, a couple of high-risk/high-reward
 * routes, and a distinct landmark per district so a player navigates by memory
 * rather than by minimap. The organising idea here is that **each district has
 * a different street grammar**, because that is what makes route knowledge
 * possible at all — you know where you are by the *texture* of the streets
 * before you have read a single sign.
 *
 * ```
 *              -480                    0                    +480
 *      -480  ┌──────────────────────────┬──────────────────────────┐
 *            │  LEDGER                  │  SPINE                   │
 *            │  tight 65-unit grid      │  few wide arterials      │
 *            │  slow, predictable,      │  fast, committed,        │
 *            │  many junctions          │  few ways to change      │
 *            │        ╲ the Crease      │  your mind               │
 *       +40  ├─────────╲────────────────┴──────────────────────────┤  north bank
 *            │══════════╲════════[ ]═════════════════════[ ]═══    │  THE CUT
 *      +165  ├───────────╲──────────────┬──────────────────────────┤  south bank
 *            │  WARRENS   ╲             │  YARDS                   │
 *            │  angled, narrow,         │  sparse, long blocks,    │
 *            │  one-way couplet,        │  wide open, fast but     │
 *            │  shortcut-rich, risky    │  far from everything     │
 *      +480  └──────────────────────────┴──────────────────────────┘
 * ```
 *
 * ## Size: 960 units, not the 1,200 that `D-04` recorded
 *
 * A deliberate revision, with the arithmetic. `CarTuning.maxSpeed` is 30
 * units/s, so 1,200 units is **exactly 40 s** in a straight line — the top of
 * the brief's 25–40 s band, in the best case that never happens. Every real
 * crossing has junctions and turns in it and runs perhaps 1.3× the straight
 * line, which puts a 1,200-unit city at 50 s or more: outside the brief on
 * every actual journey.
 *
 * At 960 the straight line is 32 s. **Measured on the finished network, the
 * three edge-to-edge crossings run 32.8 s, 37.6 s and 38.3 s** — inside the
 * band, on the real road layout rather than in a straight line. The median
 * journey between any two junctions is 19.3 s and the 90th percentile 33.7 s,
 * which is the spread a fare should have.
 *
 * `W-03` also says, twice, *"smaller than instinct suggests — if in doubt, cut
 * it."*
 *
 * ## The Cut, and why the city needs a barrier
 *
 * A grid with no barrier has no interesting routing: every path is the same
 * length as every other. The Cut — a disused rail cutting running east–west
 * just south of centre — is what turns "which way do I go" into a real
 * question, because there are only **three bridges and one way round the end**.
 *
 * It is also the reason the districts feel far apart despite the city being
 * small. Distance is cheap; *inaccessibility* is what makes a city feel large,
 * and it costs no world units at all.
 *
 * ## The five shortcuts
 *
 * 1. **The Crease.** A 45° avenue cutting diagonally across the Ledger's grid,
 *    then through the middle of the Cut and on into the Yards. **Measured
 *    against the same journey with the diagonal removed: 24% faster from the
 *    north-west Ledger to the Yards (33.0 s vs 43.4 s), and 43% from the middle
 *    of the Ledger to the south bank (18.1 s vs 31.7 s).**
 * 2. **The centre bridge** is Crease-only, and it is worth **43%** — 11.6 s
 *    against 20.3 s for a driver who does not know the diagonal and has to
 *    detour to the west or east bridge.
 * 3. **The Warrens couplet.** Two angled one-ways. Northbound works on one
 *    street and southbound on the other; take the wrong one and you are
 *    committed the whole way.
 * 4. **The Yard cut.** A road across the open Yards that begins mid-block and
 *    is easy to miss, joining two arterials that otherwise meet a long way
 *    round.
 * 5. **The end-arounds.** The ring road crosses the Cut at both map edges. They
 *    are the slow answer — reaching one can mean driving the perimeter, up to
 *    960 units — but they are the reason a missed bridge is a mistake rather
 *    than a wall.
 *
 * ## Risk and reward
 *
 * The **ring road** is wide, fast and long — the safe option, and usually the
 * slow one. The **Crease** is the fast option and carries every cross-street in
 * the Ledger at an angle, so it has the most conflicting traffic in the city.
 * The **Warrens** are faster still for anyone who knows them, and punish anyone
 * who does not with one-ways that commit you for two hundred units.
 *
 * That is the intended shape of a decision: safe/slow, fast/busy, fastest/only
 * if you know it.
 */
import type { CityJson } from '@deadhead/proto';

import { Builder } from './builder.js';

/** Half the city, in world units. The city spans `-EXTENT .. +EXTENT`. */
export const EXTENT = 480;

/** The Ledger's block pitch. Everything in the north-west is a multiple of it. */
const PITCH = 65;

/** Ledger grid lines: -480, -415, … , +40. Nine lines, eight blocks. */
const LEDGER_LINES: number[] = Array.from({ length: 9 }, (_, i) => -EXTENT + i * PITCH);

/** The street that runs along the north lip of the Cut — and the Ledger's last row. */
const NORTH_BANK = 40;
/** The street along the south lip. */
const SOUTH_BANK = 165;

/**
 * The Cut itself: the band with no streets in it, between the two bank roads.
 *
 * Nothing places geometry here — {@link Builder.carve} fills every part of the
 * city the streets do not use, so the Cut is solid simply because no street
 * crosses it except at a bridge. Kept as constants because they are what the
 * bridge gaps and the bank roads are positioned against.
 */
const CUT_TOP = 95;
const CUT_BOTTOM = 135;
/**
 * The Cut runs the full width, and the ring road crosses it at both edges.
 *
 * Those two crossings are the **end-arounds**, and they are not a leak in the
 * barrier — they are the slow answer. Reaching one means driving out to the
 * perimeter and back, up to 960 units, so the bridges still decide every
 * journey that does not start near an edge. A barrier with no way round at all
 * would not be a routing problem, it would be two cities.
 *
 * An earlier draft stopped the Cut at x = 400 and described *one* end-around,
 * on the east. That was simply wrong about its own geometry: the ring road
 * crosses on the west too, and {@link assertCutIntact} said so the moment it
 * was asked.
 */
const CUT_EAST_END = EXTENT;

/** Bridge gaps in the Cut, as `[fromX, toX]`. */
const WEST_BRIDGE: readonly [number, number] = [-330, -290];
/** Wide, because the Crease crosses it at 45° and needs the room. */
const CREASE_BRIDGE: readonly [number, number] = [70, 170];
const EAST_BRIDGE: readonly [number, number] = [250, 290];

const ARTERIAL = 12;
const RING = 14;
const STREET = 8;
const ALLEY = 6;

/**
 * The Cut is intact: no street crosses it except at a bridge.
 *
 * Since {@link Builder.carve} fills whatever the streets leave, the Cut is a
 * barrier only because nothing is drawn through it — which makes it an
 * invariant held by omission, and those rot. Someone adding an innocuous
 * north–south street through `y = 115` would quietly delete the feature the
 * whole city routes around, and every audit rule would still pass.
 *
 * So it is asserted rather than assumed. This is the one piece of City 01's
 * *design* that a general-purpose audit cannot know to check.
 */
export function assertCutIntact(city: CityJson): string[] {
  const gaps = [WEST_BRIDGE, CREASE_BRIDGE, EAST_BRIDGE];
  const problems: string[] = [];

  city.edges.forEach((edge, index) => {
    const a = city.nodes[edge.a]!;
    const b = city.nodes[edge.b]!;
    // Only streets that actually get from one side of the band to the other.
    const spans = (a.y <= CUT_TOP && b.y >= CUT_BOTTOM) || (b.y <= CUT_TOP && a.y >= CUT_BOTTOM);
    if (!spans) return;

    const midX = (a.x + b.x) / 2;
    if (midX > CUT_EAST_END) return;

    // The ring road crosses at both map edges. Those are the end-arounds —
    // deliberate, and the slowest way across by a long way.
    if (Math.abs(midX) >= EXTENT - RING) return;

    const inGap = gaps.some(([from, to]) => {
      const crossTop = crossingX(a, b, CUT_TOP);
      const crossBottom = crossingX(a, b, CUT_BOTTOM);
      return crossTop >= from && crossTop <= to && crossBottom >= from && crossBottom <= to;
    });
    if (!inGap) {
      problems.push(`road ${index} crosses the Cut at x≈${midX.toFixed(0)}, which is not a bridge`);
    }
  });

  return problems;
}

/** Where a segment passes a given y. */
function crossingX(a: { x: number; y: number }, b: { x: number; y: number }, y: number): number {
  if (a.y === b.y) return a.x;
  return a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x);
}

export function buildCity01(): CityJson {
  const b = new Builder('creaseway-01');

  ring(b);
  ledger(b);
  spine(b);
  banks(b);
  crease(b);
  warrens(b);
  yards(b);
  // Streets are declared independently, so the crossings between them have to
  // be made real before anything is placed against them.
  b.weld();

  // Buildings are carved from what the streets leave, not authored beside them.
  // The Cut needs no special handling: it is simply a band of the city with no
  // streets in it, so carving fills it solid and the bridges fall out as the
  // gaps where bridge roads run.
  b.carve({ bounds: [-EXTENT, -EXTENT, EXTENT, EXTENT] });

  landmarks(b);
  demand(b);
  passengers(b);

  return b.city;
}

// ---------------------------------------------------------------------------
// Streets
// ---------------------------------------------------------------------------

/**
 * The ring road.
 *
 * Wide and fast, and the reason a wrong turn is survivable: whatever else
 * happens, the perimeter gets you anywhere eventually. It is also the slow
 * answer almost every time, which is what makes taking it a decision rather
 * than a default.
 */
function ring(b: Builder): void {
  b.street(
    [
      [-EXTENT, -EXTENT],
      [EXTENT, -EXTENT],
      [EXTENT, EXTENT],
      [-EXTENT, EXTENT],
      [-EXTENT, -EXTENT],
    ],
    { width: RING, name: 'Ring' },
  );
}

/**
 * The Ledger — a tight, regular, entirely predictable grid.
 *
 * Deliberately the dullest district, and deliberately the one with the most
 * junctions. It is slow, it is never surprising, and it is the baseline the
 * other three are read against. A city where everywhere is interesting has
 * nowhere that feels fast.
 */
function ledger(b: Builder): void {
  const xs = LEDGER_LINES.filter((x) => x <= -25);
  const ys = LEDGER_LINES;

  for (const x of xs) {
    b.street(
      ys.map((y) => [x, y] as const),
      { width: STREET },
    );
  }
  for (const y of ys) {
    b.street(
      xs.map((x) => [x, y] as const),
      { width: STREET },
    );
  }
}

/**
 * The Spine — few streets, long blocks, wide carriageways.
 *
 * The opposite trade to the Ledger: quick to cross, and almost impossible to
 * change your mind inside. Miss your turning here and the next one is 175 units
 * away.
 */
function spine(b: Builder): void {
  const xs = [-25, 150, 325, EXTENT];
  const ys = [-EXTENT, -300, -130, NORTH_BANK];

  for (const x of xs) {
    b.street(
      ys.map((y) => [x, y] as const),
      { width: ARTERIAL },
    );
  }
  for (const y of ys) {
    b.street(
      xs.map((x) => [x, y] as const),
      { width: ARTERIAL },
    );
  }
}

/** The streets along both lips of the Cut, and the two ordinary bridges. */
function banks(b: Builder): void {
  b.street(
    [
      [-EXTENT, NORTH_BANK],
      [EXTENT, NORTH_BANK],
    ],
    { width: ARTERIAL, name: 'North Bank' },
  );
  b.street(
    [
      [-EXTENT, SOUTH_BANK],
      [EXTENT, SOUTH_BANK],
    ],
    { width: ARTERIAL, name: 'South Bank' },
  );

  for (const [from, to] of [WEST_BRIDGE, EAST_BRIDGE]) {
    const x = Math.round((from + to) / 2);
    b.street(
      [
        [x, NORTH_BANK],
        [x, SOUTH_BANK],
      ],
      { width: STREET },
    );
  }

  // The east end-around: the ring road gets past the Cut without a bridge.
  b.street(
    [
      [EXTENT, NORTH_BANK],
      [EXTENT, SOUTH_BANK],
    ],
    { width: RING },
  );
}

/**
 * The Crease — the diagonal the city is named for.
 *
 * Runs at exactly 45° so that inside the Ledger it lands on grid junctions
 * rather than cutting blocks in half: every point on the north-west leg is a
 * crossing that already existed. That is what makes it a *shortcut* rather than
 * a separate road — you can join and leave it anywhere along the grid.
 *
 * Measured saving over the same journey with the diagonal deleted: **24% to
 * 43%**, depending on how much of it the route uses. The theoretical √2 is 29%;
 * the real figure runs higher on journeys that also inherit the centre bridge.
 *
 * It then takes the centre of the Cut, which nothing else does, and continues
 * into the Yards.
 */
function crease(b: Builder): void {
  const northWestLeg = LEDGER_LINES.filter((v) => v <= -25).map((v) => [v, v] as const);

  b.street([...northWestLeg, [NORTH_BANK, NORTH_BANK]], { width: ARTERIAL, name: 'Crease' });

  // Through the Cut. The gap is 100 wide and the diagonal crosses it between
  // x=95 and x=135, so it clears the buildings on both sides.
  b.street(
    [
      [NORTH_BANK, NORTH_BANK],
      [SOUTH_BANK, SOUTH_BANK],
    ],
    { width: ARTERIAL, name: 'Crease' },
  );

  // And on into the Yards, where it finally meets the ring road.
  b.street(
    [
      [SOUTH_BANK, SOUTH_BANK],
      [300, 300],
      [EXTENT, EXTENT],
    ],
    { width: ARTERIAL, name: 'Crease' },
  );
}

/**
 * The Warrens — angled, narrow, and one-way where it hurts.
 *
 * `W-02`'s `audit` insists the one-ways form a cycle, which is the right
 * constraint: a one-way that strands you is a bug, a one-way that *commits* you
 * is design. The couplet here does the second. Northbound traffic uses Kiln
 * Row; southbound uses Tanner's.
 *
 * **Measured asymmetry: 12.0 s south-to-north, 17.8 s north-to-south** over the
 * same pair of points — 48% more to go back the way you came. That gap is the
 * knowledge the district is worth.
 */
function warrens(b: Builder): void {
  // Two-way spine of the district, bending as it climbs.
  b.street(
    [
      [-EXTENT, SOUTH_BANK],
      [-390, 250],
      [-330, 350],
      [-300, EXTENT],
    ],
    { width: STREET, name: 'Warren Row' },
  );

  // The couplet. Northbound, toward the Cut.
  b.street(
    [
      [-160, EXTENT],
      [-215, 370],
      [-285, 265],
      [-330, SOUTH_BANK],
    ],
    { width: ALLEY, oneWay: true, name: 'Kiln Row' },
  );

  // Southbound, away from it.
  b.street(
    [
      [-250, SOUTH_BANK],
      [-190, 265],
      [-125, 375],
      [-70, EXTENT],
    ],
    { width: ALLEY, oneWay: true, name: "Tanner's" },
  );

  // Cross-links, so the couplet is a loop rather than two dead ends.
  b.street(
    [
      [-390, 250],
      [-285, 265],
      [-190, 265],
    ],
    { width: ALLEY },
  );
  b.street(
    [
      [-330, 350],
      [-215, 370],
      [-125, 375],
    ],
    { width: ALLEY },
  );
}

/**
 * The Yards — sparse, open, and quick if you are already going that way.
 *
 * Few roads and long blocks, so it is fast to cross and slow to reach anywhere
 * *inside*. The Yard cut is the shortcut: it starts mid-block off the south
 * bank and rejoins the eastern arterial, which otherwise costs the long way
 * round three sides of a block.
 */
function yards(b: Builder): void {
  const xs = [-25, 180, 385];
  const ys = [SOUTH_BANK, 330, EXTENT];

  for (const x of xs) {
    b.street(
      ys.map((y) => [x, y] as const),
      { width: STREET },
    );
  }
  for (const y of ys) {
    b.street(
      xs.map((x) => [x, y] as const),
      { width: STREET },
    );
  }

  // The Yard cut — easy to miss, and worth knowing.
  b.street(
    [
      [90, SOUTH_BANK],
      [140, 245],
      [280, 260],
      [385, 330],
    ],
    { width: ALLEY, name: 'Yard Cut' },
  );
}

// ---------------------------------------------------------------------------
// Navigation and demand
// ---------------------------------------------------------------------------

/**
 * One silhouette per district, so a player can place themselves without a map.
 *
 * `DESIGN.md` §2.4 is explicit that there is no floating destination arrow, so
 * these are load-bearing rather than decorative — they are the *only* thing
 * that tells you which quarter of the city you are looking at.
 */
function landmarks(b: Builder): void {
  b.landmark(-253, -253, 'The Exchange');
  b.landmark(300, -215, 'The Mast');
  b.landmark(-355, 310, 'The Kiln');
  b.landmark(280, 250, 'The Gantry');
  b.landmark(120, 115, 'The Fold');
}

/**
 * Demand anchors, phased so the busy quarter migrates across a run.
 *
 * `DESIGN.md` §2.2 wants the routing story to change while you play. The
 * Ledger opens the run, the Spine takes over, then the Yards, and the Warrens
 * peak last — which puts the hardest district to drive at the point where the
 * fares are worth most.
 */
function demand(b: Builder): void {
  b.demand(-250, -250, 260, 0);
  b.demand(300, -220, 280, 70);
  b.demand(280, 320, 270, 140);
  b.demand(-280, 330, 250, 200);
}

/**
 * Passenger points, laid on kerbs, spread by district and kept apart.
 *
 * **Generated from the junction list rather than hand-listed**, because
 * hand-listing produced a city that could not migrate. The first version had 7
 * spawns in the north-west and **2** in the north-east — and demand cannot move
 * *into* a district that has nowhere to arrive. Measured over a 180 s run, the
 * north-east's share of spawns went 11% → 27% → 0% → 0%: not a migrating field,
 * a quantisation artefact of having two sites.
 *
 * Three constraints, all of which have a reason:
 *
 * - **Balanced across the four quarters**, so a demand anchor has somewhere to
 *   be answered wherever it peaks.
 * - **Spread within a quarter** (`MIN_APART`), so a district's demand is not
 *   really one street corner.
 * - **Spawns kept away from destinations** (`SEPARATION`). `S-09` picks a
 *   destination uniformly at random and *independently of the spawn*, so any
 *   pair can come up, and a close pair is a fare that pays the base rate for no
 *   driving — the `S-10` finding, as a property of the city.
 *
 * Deterministic throughout: junctions are walked in index order and chosen
 * greedily, so the same city comes out every time.
 */
function passengers(b: Builder): void {
  const PER_DISTRICT = 5;
  /** Spacing between two points of the same kind, so a district is not one corner. */
  const MIN_APART = 110;
  /** Spacing between a spawn and a destination — see the note above on `S-10`. */
  const SEPARATION = 90;

  const quadrant = (p: { x: number; y: number }): string =>
    `${p.y < 0 ? 'N' : 'S'}${p.x < 0 ? 'W' : 'E'}`;

  const far = (
    point: { x: number; y: number },
    others: readonly { x: number; y: number }[],
    least: number,
  ): boolean => others.every((o) => Math.hypot(o.x - point.x, o.y - point.y) >= least);

  const spawns: { x: number; y: number }[] = [];
  const destinations: { x: number; y: number }[] = [];
  const spawnCount = new Map<string, number>();
  const destCount = new Map<string, number>();

  // **Interleaved, not two passes.** Placing every spawn first and then asking
  // destinations to keep their distance starves them: the first attempt put 21
  // spawns down and could only fit 9 destinations around them. Alternating by
  // district lets the two sets grow into each other's gaps instead.
  for (let i = 0; i < b.city.nodes.length; i += 1) {
    const node = b.city.nodes[i]!;
    const district = quadrant(node);

    const haveSpawns = spawnCount.get(district) ?? 0;
    const haveDests = destCount.get(district) ?? 0;
    if (haveSpawns >= PER_DISTRICT && haveDests >= PER_DISTRICT) continue;

    // Whichever this district is shorter of, so the two stay in step.
    const role: 'spawn' | 'destination' =
      haveSpawns <= haveDests && haveSpawns < PER_DISTRICT ? 'spawn' : 'destination';
    if (role === 'destination' && haveDests >= PER_DISTRICT) continue;

    // Probe from just *inside* the junction rather than on it. `snapKerb` puts
    // the passenger on whichever side the point was, and a junction sits on the
    // centreline where that has no answer — so on the ring road it could place
    // someone on the outward kerb, facing off the edge of the map.
    //
    // Nudging the probe toward the origin makes the choice for it. An earlier
    // version instead *skipped* every junction near the edge, which threw away
    // the whole outer ring: in the sparse Spine that was most of the district,
    // and it is why the north-east could only ever field two sites.
    const inward = 3;
    const kerb = b.kerb(
      node.x - Math.sign(node.x) * inward,
      node.y - Math.sign(node.y) * inward,
      role,
    );
    if (kerb === null) continue;

    // A kerb can still land outside the city. At the map corners the probe sits
    // exactly on the Crease's centreline, where "which side" has no answer and
    // `snapKerb` falls back to an arbitrary one — which at (-480, -480) put a
    // passenger at (-481, -473), off the edge of the world. Cheaper to reject
    // the point than to teach the snap about map bounds it knows nothing about.
    if (Math.abs(kerb.x) > EXTENT || Math.abs(kerb.y) > EXTENT) continue;

    const same = role === 'spawn' ? spawns : destinations;
    const other = role === 'spawn' ? destinations : spawns;
    if (!far(kerb, same, MIN_APART)) continue;
    if (!far(kerb, other, SEPARATION)) continue;

    same.push(kerb);
    (role === 'spawn' ? spawnCount : destCount).set(
      district,
      (role === 'spawn' ? haveSpawns : haveDests) + 1,
    );
  }

  for (const point of spawns) b.doc.addSpawn(point);
  for (const point of destinations) b.doc.addDestination(point);
}
