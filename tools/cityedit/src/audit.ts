/**
 * `audit.ts` — is this city playable?
 *
 * `W-02`'s brief asks for a validation pass over an authored city: unreachable
 * spawns, dead-end nav nodes, destinations inside buildings, spawn points with
 * no road access. This is that pass, plus the rules that fell out of building
 * it.
 *
 * ## Why this is not `validateCity`
 *
 * `@deadhead/proto`'s {@link validateCity} answers a different question and
 * answers it differently. It asks **"will this load without breaking the sim"**
 * — content hash matches, no edge points at a node that does not exist, no
 * self-loops, no inverted boxes — and it **throws** on the first violation,
 * because a city that fails it must never reach `step()`.
 *
 * This asks **"is this a good city"**, and it **reports**. Everything here is
 * about play rather than integrity: a spawn nobody can drive to loads perfectly
 * and produces an unplayable fare. And an author needs the whole list at once —
 * throwing on the first problem turns a ten-minute fix into ten separate
 * round-trips through the editor.
 *
 * So: `validateCity` throws and is a gate; `audit` returns findings and is a
 * report. Both run. Neither replaces the other.
 *
 * ## The rule worth understanding: strong connectivity
 *
 * The obvious reachability check treats the road graph as undirected and looks
 * for islands. That is not enough once `W-03` has one-way streets, which it
 * explicitly wants for route knowledge.
 *
 * An undirected check says a district is attached if *any* road touches it. A
 * driver cares whether they can get in **and back out**. A one-way authored the
 * wrong way round produces a region you can drive into and never leave — a trap
 * that looks perfectly connected on a map, passes every structural check, and
 * is discovered by a playtester sitting in it.
 *
 * So reachability here is **strong** connectivity: nodes are grouped into
 * strongly-connected components, and anything outside the largest one is
 * reported. That catches the island *and* the trap, which the undirected
 * version cannot distinguish.
 *
 * ## Plain floats, deliberately
 *
 * Authoring-time, in a tool, on whole-unit coordinates. Nothing here is hashed,
 * stepped or transmitted, so the sim's fixed-point discipline (ADR 0003) does
 * not apply and would only obscure the geometry.
 */
import { EdgeFlags, type CityBox, type CityJson, type CityPoint } from '@deadhead/proto';

export type Severity = 'error' | 'warning';

/** What a finding points at, so the editor can select it. */
export interface Subject {
  readonly kind: 'node' | 'edge' | 'building' | 'spawn' | 'destination' | 'landmark' | 'anchor';
  readonly index: number;
}

export interface Finding {
  /** Stable machine-readable id. Tests and the editor's filter key off this. */
  readonly rule: string;
  readonly severity: Severity;
  /** One sentence, addressed to whoever is authoring the city. */
  readonly message: string;
  readonly subject?: Subject;
}

export interface AuditOptions {
  /**
   * How far a spawn or destination may sit from the nearest carriageway edge.
   *
   * Passengers stand on the pavement, so some distance is correct; too much and
   * the cab cannot reach them. Measured to the road *centreline*, so this has
   * to clear half the widest carriageway plus a pavement.
   */
  readonly maxRoadDistance: number;
  /**
   * The shortest a fare may be, in units.
   *
   * Surfaced by `S-10`: a passenger whose destination is the kerb they are
   * standing on is delivered the instant they get in, for the base fare and no
   * driving. The sim is behaving correctly — the *city* is wrong. A test
   * accidentally authored exactly that, which is how the rule got written.
   */
  readonly minFareDistance: number;
}

export const DEFAULT_AUDIT_OPTIONS: AuditOptions = {
  maxRoadDistance: 12,
  minFareDistance: 60,
};

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Whether a point is inside a box. Edges count as inside. */
export function pointInBox(point: { x: number; y: number }, box: CityBox): boolean {
  return point.x >= box.minX && point.x <= box.maxX && point.y >= box.minY && point.y <= box.maxY;
}

/**
 * Distance from a point to a line segment.
 *
 * The segment case, not the infinite-line case: a spawn beyond the end of a
 * street is far from that street, and measuring to the infinite line would call
 * it adjacent.
 */
export function distanceToSegment(
  point: { x: number; y: number },
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) return Math.hypot(point.x - ax, point.y - ay);

  // Projection of the point onto the segment, clamped to its ends.
  let t = ((point.x - ax) * dx + (point.y - ay) * dy) / lengthSquared;
  t = t < 0 ? 0 : t > 1 ? 1 : t;

  return Math.hypot(point.x - (ax + t * dx), point.y - (ay + t * dy));
}

/** Distance from a point to the nearest road centreline. `Infinity` if there are no roads. */
export function distanceToNearestRoad(point: { x: number; y: number }, city: CityJson): number {
  let best = Number.POSITIVE_INFINITY;
  for (const edge of city.edges) {
    const a = city.nodes[edge.a];
    const b = city.nodes[edge.b];
    if (a === undefined || b === undefined) continue; // validateCity's problem, not ours
    const distance = distanceToSegment(point, a.x, a.y, b.x, b.y);
    if (distance < best) best = distance;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

/** Directed adjacency, honouring one-way flags. */
function buildAdjacency(city: CityJson): number[][] {
  const out: number[][] = Array.from({ length: city.nodes.length }, () => []);
  for (const edge of city.edges) {
    if (city.nodes[edge.a] === undefined || city.nodes[edge.b] === undefined) continue;
    out[edge.a]!.push(edge.b);
    if (((edge.flags ?? 0) & EdgeFlags.OneWay) === 0) out[edge.b]!.push(edge.a);
  }
  return out;
}

function reverse(adjacency: number[][]): number[][] {
  const out: number[][] = Array.from({ length: adjacency.length }, () => []);
  for (let from = 0; from < adjacency.length; from += 1) {
    for (const to of adjacency[from]!) out[to]!.push(from);
  }
  return out;
}

/** Iterative DFS post-order. Iterative because a long street is a deep graph. */
function postOrder(adjacency: number[][]): number[] {
  const seen = new Uint8Array(adjacency.length);
  const order: number[] = [];

  for (let root = 0; root < adjacency.length; root += 1) {
    if (seen[root] === 1) continue;
    // Each frame is [node, nextChildIndex] so the walk can resume where it left off.
    const stack: [number, number][] = [[root, 0]];
    seen[root] = 1;

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const [node, cursor] = frame;
      const neighbours = adjacency[node]!;

      if (cursor < neighbours.length) {
        frame[1] += 1;
        const next = neighbours[cursor]!;
        if (seen[next] === 0) {
          seen[next] = 1;
          stack.push([next, 0]);
        }
      } else {
        order.push(node);
        stack.pop();
      }
    }
  }
  return order;
}

/**
 * Strongly-connected components, by Kosaraju.
 *
 * Returns a component id per node. Two nodes share an id exactly when each can
 * be driven to from the other — which is the property that matters, and the one
 * an undirected check cannot see.
 */
export function stronglyConnectedComponents(city: CityJson): Int32Array {
  const adjacency = buildAdjacency(city);
  const order = postOrder(adjacency);
  const transposed = reverse(adjacency);

  const component = new Int32Array(adjacency.length).fill(-1);
  let next = 0;

  for (let i = order.length - 1; i >= 0; i -= 1) {
    const root = order[i]!;
    if (component[root] !== -1) continue;

    const stack = [root];
    component[root] = next;
    while (stack.length > 0) {
      const node = stack.pop()!;
      for (const neighbour of transposed[node]!) {
        if (component[neighbour] === -1) {
          component[neighbour] = next;
          stack.push(neighbour);
        }
      }
    }
    next += 1;
  }
  return component;
}

/** The component id holding the most nodes — the city proper. */
function largestComponent(component: Int32Array): number {
  if (component.length === 0) return -1;
  const counts = new Map<number, number>();
  for (const id of component) counts.set(id, (counts.get(id) ?? 0) + 1);

  let best = -1;
  let bestCount = -1;
  for (const [id, count] of counts) {
    // Ties broken by lower id so the result is stable run to run.
    if (count > bestCount || (count === bestCount && id < best)) {
      best = id;
      bestCount = count;
    }
  }
  return best;
}

/** How many distinct directions lead out of each node. */
function exitCounts(city: CityJson): number[] {
  const adjacency = buildAdjacency(city);
  return adjacency.map((neighbours) => new Set(neighbours).size);
}

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

/**
 * Every playability problem in a city, most severe first.
 *
 * Never throws — a half-authored city in an editor is *expected* to be broken,
 * and an author needs the whole list rather than the first item.
 */
export function audit(city: CityJson, options: Partial<AuditOptions> = {}): Finding[] {
  const settings = { ...DEFAULT_AUDIT_OPTIONS, ...options };
  const findings: Finding[] = [];

  const add = (rule: string, severity: Severity, message: string, subject?: Subject): void => {
    // `subject` is omitted rather than set to undefined: the repo runs
    // `exactOptionalPropertyTypes`, under which `{ subject: undefined }` is not
    // assignable to `{ subject?: Subject }`. The distinction is the point of the
    // flag — an absent key and a present-but-undefined one are different things.
    findings.push(
      subject === undefined ? { rule, severity, message } : { rule, severity, message, subject },
    );
  };

  // --- the city has to be able to produce a fare at all --------------------

  if (city.edges.length === 0) {
    add('no-roads', 'error', 'The city has no roads, so nothing can be driven.');
  }
  if (city.spawns.length === 0) {
    add('no-spawns', 'error', 'The city has no passenger spawn points, so no fare can ever start.');
  }
  if (city.destinations.length === 0) {
    add(
      'no-destinations',
      'error',
      'The city has no destinations, so a passenger who gets in can never be delivered.',
    );
  }

  // --- points that are somewhere impossible --------------------------------

  const checkPoint = (
    point: CityPoint,
    index: number,
    kind: 'spawn' | 'destination' | 'landmark',
  ): void => {
    for (let b = 0; b < city.buildings.length; b += 1) {
      if (pointInBox(point, city.buildings[b]!)) {
        add(
          'point-inside-building',
          kind === 'landmark' ? 'warning' : 'error',
          `${label(kind)} ${index} at (${point.x}, ${point.y}) is inside building ${b}.`,
          { kind, index },
        );
        break;
      }
    }

    if (kind === 'landmark') return; // a landmark is a silhouette, not a place to drive to

    if (city.edges.length > 0) {
      const distance = distanceToNearestRoad(point, city);
      if (distance > settings.maxRoadDistance) {
        add(
          'no-road-access',
          'error',
          `${label(kind)} ${index} is ${distance.toFixed(1)} units from the nearest road ` +
            `(limit ${settings.maxRoadDistance}), so a cab cannot reach it.`,
          { kind, index },
        );
      }
    }
  };

  city.spawns.forEach((point, index) => checkPoint(point, index, 'spawn'));
  city.destinations.forEach((point, index) => checkPoint(point, index, 'destination'));
  city.landmarks.forEach((point, index) => checkPoint(point, index, 'landmark'));

  // --- fares that are over before they start -------------------------------

  // S-10's finding: a destination on the kerb the passenger is standing on pays
  // the base fare for no driving. The sim is right; the city is wrong.
  for (let s = 0; s < city.spawns.length; s += 1) {
    const spawn = city.spawns[s]!;
    for (let d = 0; d < city.destinations.length; d += 1) {
      const destination = city.destinations[d]!;
      const distance = Math.hypot(destination.x - spawn.x, destination.y - spawn.y);
      if (distance < settings.minFareDistance) {
        add(
          'fare-too-short',
          'warning',
          `Destination ${d} is only ${distance.toFixed(1)} units from spawn ${s} ` +
            `(minimum ${settings.minFareDistance}). A passenger matched to it is delivered ` +
            `almost immediately, for the base fare and no driving.`,
          { kind: 'destination', index: d },
        );
      }
    }
  }

  // --- the road network ----------------------------------------------------

  if (city.nodes.length > 0 && city.edges.length > 0) {
    const component = stronglyConnectedComponents(city);
    const main = largestComponent(component);

    for (let node = 0; node < city.nodes.length; node += 1) {
      if (component[node] === main) continue;
      const position = city.nodes[node]!;
      add(
        'unreachable',
        'error',
        `Junction ${node} at (${position.x}, ${position.y}) is not strongly connected to the ` +
          `main road network — a cab cannot both reach it and leave it. A one-way street ` +
          `pointing the wrong way is the usual cause.`,
        { kind: 'node', index: node },
      );
    }

    const exits = exitCounts(city);
    for (let node = 0; node < city.nodes.length; node += 1) {
      if (exits[node] === 0) {
        add(
          'no-exit',
          'error',
          `Junction ${node} has no way out. Any cab that arrives is stuck there.`,
          { kind: 'node', index: node },
        );
      } else if (exits[node] === 1) {
        add(
          'dead-end',
          'warning',
          `Junction ${node} is a dead end — the only way out is the way in. NPC traffic ` +
            `(S-08) has to U-turn there, which reads badly.`,
          { kind: 'node', index: node },
        );
      }
    }

    // A junction nothing connects to is authored-but-orphaned; worth saying
    // separately because "unreachable" would otherwise be the only clue.
    for (let node = 0; node < city.nodes.length; node += 1) {
      const used = city.edges.some((edge) => edge.a === node || edge.b === node);
      if (!used) {
        add('orphan-node', 'warning', `Junction ${node} has no roads attached to it.`, {
          kind: 'node',
          index: node,
        });
      }
    }
  }

  // --- demand anchors ------------------------------------------------------

  city.demandAnchors.forEach((anchor, index) => {
    if (anchor.radius <= 0) {
      add('anchor-no-radius', 'error', `Demand anchor ${index} has a non-positive radius.`, {
        kind: 'anchor',
        index,
      });
    }
    if (anchor.phase !== undefined && (anchor.phase < 0 || anchor.phase > 255)) {
      add(
        'anchor-phase-range',
        'error',
        `Demand anchor ${index} has phase ${anchor.phase}, outside 0–255 (1/256ths of a run).`,
        { kind: 'anchor', index },
      );
    }
  });

  // --- names ---------------------------------------------------------------

  const nameCount = city.names.length;
  const checkName = (value: number | undefined, kind: Subject['kind'], index: number): void => {
    if (value === undefined) return;
    if (!Number.isInteger(value) || value < 0 || value >= nameCount) {
      add(
        'bad-name-index',
        'error',
        `${label(kind)} ${index} references name ${value}, but there are ${nameCount} names.`,
        { kind, index },
      );
    }
  };
  city.nodes.forEach((node, index) => checkName(node.name, 'node', index));
  city.spawns.forEach((point, index) => checkName(point.name, 'spawn', index));
  city.destinations.forEach((point, index) => checkName(point.name, 'destination', index));
  city.landmarks.forEach((point, index) => checkName(point.name, 'landmark', index));

  // Errors first, then warnings; original order within each.
  return [
    ...findings.filter((f) => f.severity === 'error'),
    ...findings.filter((f) => f.severity === 'warning'),
  ];
}

function label(kind: Subject['kind']): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/** True if nothing in the audit would stop the city being played. */
export function isPlayable(findings: readonly Finding[]): boolean {
  return !findings.some((finding) => finding.severity === 'error');
}

/** A short report, for the editor's panel and for `W-03`'s CLI check. */
export function formatFindings(findings: readonly Finding[]): string {
  if (findings.length === 0) return 'No problems found.';

  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.length - errors;
  const header = `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`;

  const lines = findings.map(
    (finding) =>
      `  ${finding.severity === 'error' ? '✖' : '⚠'} [${finding.rule}] ${finding.message}`,
  );
  return `${header}\n${lines.join('\n')}`;
}
