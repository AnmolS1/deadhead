/**
 * `document.ts` — the city being edited.
 *
 * A {@link CityJson} is the *file format*. This is the thing the editor holds
 * while you work: the same data, plus edit operations that keep it consistent,
 * plus undo.
 *
 * ## The bug this module exists to prevent
 *
 * `CityJson` addresses everything **by index**. An edge names its junctions as
 * `{ a: 3, b: 5 }`; a spawn names its street as `name: 2`. So **deletion is the
 * dangerous operation**: remove node 3 from the array and every edge that
 * referenced node 5 now points at node 4. The city remains structurally valid,
 * `validateCity` passes, `audit` passes — and the roads have quietly moved.
 *
 * That is the worst shape a bug can take, because the output is *plausible*.
 * Nothing looks broken; the city is just not the one that was drawn. It would
 * survive any amount of casual testing and surface as "the city feels wrong"
 * three weeks later.
 *
 * So every removal here renumbers every reference to everything after it, and
 * drops the references that pointed at the removed thing. {@link removeNode}
 * additionally removes the roads that ran through it, because an edge to a
 * junction that no longer exists is not a road.
 *
 * ## Undo is snapshot-based, deliberately
 *
 * The alternative — a command log with an inverse per operation — is smaller in
 * memory and much easier to get subtly wrong: every new operation needs a
 * matching inverse, and an inverse that is a little bit incorrect corrupts the
 * document in a way that only appears after an undo.
 *
 * A whole city is a few hundred kilobytes of plain JSON. Snapshotting it is
 * free at authoring time, is impossible to get wrong, and means a new operation
 * needs no undo support at all. Correctness beats cleverness for a tool whose
 * entire job is not to lose your work.
 */
import {
  emptyCityJson,
  packCity,
  validateCity,
  type CityBox,
  type CityDemandAnchor,
  type CityEdge,
  type CityJson,
  type CityNode,
  type CityPoint,
} from '@deadhead/proto';

import { audit, isPlayable, type Finding } from './audit.js';

/** How many undo steps to keep. */
export const DEFAULT_HISTORY_LIMIT = 100;

/** A mutable city, with history. */
export class CityDocument {
  private state: CityJson;
  private readonly past: CityJson[] = [];
  private readonly future: CityJson[] = [];
  private readonly historyLimit: number;

  constructor(initial: CityJson = emptyCityJson(), historyLimit = DEFAULT_HISTORY_LIMIT) {
    if (!Number.isInteger(historyLimit) || historyLimit < 1) {
      throw new RangeError('historyLimit must be a positive integer');
    }
    this.state = initial;
    this.historyLimit = historyLimit;
  }

  /** The city as it stands. Treat as immutable — use the operations to change it. */
  get city(): CityJson {
    return this.state;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /**
   * Apply a change, recording the previous state for undo.
   *
   * Every mutating operation goes through here, which is what makes undo
   * complete by construction rather than by remembering to support it.
   */
  private commit(next: CityJson): void {
    this.past.push(this.state);
    if (this.past.length > this.historyLimit) this.past.shift();
    // A new edit invalidates the redo branch, as in every editor ever.
    this.future.length = 0;
    this.state = next;
  }

  undo(): boolean {
    const previous = this.past.pop();
    if (previous === undefined) return false;
    this.future.push(this.state);
    this.state = previous;
    return true;
  }

  redo(): boolean {
    const next = this.future.pop();
    if (next === undefined) return false;
    this.past.push(this.state);
    this.state = next;
    return true;
  }

  // -------------------------------------------------------------------------
  // Adding
  // -------------------------------------------------------------------------

  /** @returns the new junction's index. */
  addNode(node: CityNode): number {
    this.commit({ ...this.state, nodes: [...this.state.nodes, node] });
    return this.state.nodes.length - 1;
  }

  /**
   * Connect two junctions.
   *
   * Refuses a self-loop and a duplicate, because `validateCity` rejects the
   * first and the second is never intentional — catching them here means the
   * editor cannot author a city that fails to load.
   */
  addEdge(edge: CityEdge): number {
    const { a, b } = edge;
    if (a === b) throw new RangeError('a road cannot connect a junction to itself');
    if (this.state.nodes[a] === undefined || this.state.nodes[b] === undefined) {
      throw new RangeError(`road references a junction that does not exist: ${a} -> ${b}`);
    }
    const duplicate = this.state.edges.some(
      (existing) =>
        (existing.a === a && existing.b === b) || (existing.a === b && existing.b === a),
    );
    if (duplicate) throw new RangeError(`a road already connects ${a} and ${b}`);

    this.commit({ ...this.state, edges: [...this.state.edges, edge] });
    return this.state.edges.length - 1;
  }

  addBuilding(box: CityBox): number {
    if (box.maxX <= box.minX || box.maxY <= box.minY) {
      throw new RangeError('a building must have positive width and height');
    }
    this.commit({ ...this.state, buildings: [...this.state.buildings, box] });
    return this.state.buildings.length - 1;
  }

  addSpawn(point: CityPoint): number {
    this.commit({ ...this.state, spawns: [...this.state.spawns, point] });
    return this.state.spawns.length - 1;
  }

  addDestination(point: CityPoint): number {
    this.commit({ ...this.state, destinations: [...this.state.destinations, point] });
    return this.state.destinations.length - 1;
  }

  addLandmark(point: CityPoint): number {
    this.commit({ ...this.state, landmarks: [...this.state.landmarks, point] });
    return this.state.landmarks.length - 1;
  }

  addDemandAnchor(anchor: CityDemandAnchor): number {
    this.commit({ ...this.state, demandAnchors: [...this.state.demandAnchors, anchor] });
    return this.state.demandAnchors.length - 1;
  }

  /** Adds a name, or returns the index of an identical one already present. */
  addName(name: string): number {
    const existing = this.state.names.indexOf(name);
    if (existing !== -1) return existing;
    this.commit({ ...this.state, names: [...this.state.names, name] });
    return this.state.names.length - 1;
  }

  // -------------------------------------------------------------------------
  // Removing — where the index bookkeeping lives
  // -------------------------------------------------------------------------

  /**
   * Remove a junction, the roads through it, and renumber everything after.
   *
   * The renumbering is the whole point. Without it, deleting junction 3 leaves
   * every edge that referenced junction 5 pointing at junction 4 — a city that
   * still validates and is no longer the one that was drawn.
   */
  removeNode(index: number): void {
    if (this.state.nodes[index] === undefined) throw new RangeError(`no junction ${index}`);

    const shift = (reference: number): number => (reference > index ? reference - 1 : reference);

    this.commit({
      ...this.state,
      nodes: this.state.nodes.filter((_, i) => i !== index),
      // Drop roads that touched it; renumber the rest.
      edges: this.state.edges
        .filter((edge) => edge.a !== index && edge.b !== index)
        .map((edge) => ({ ...edge, a: shift(edge.a), b: shift(edge.b) })),
    });
  }

  removeEdge(index: number): void {
    if (this.state.edges[index] === undefined) throw new RangeError(`no road ${index}`);
    this.commit({ ...this.state, edges: this.state.edges.filter((_, i) => i !== index) });
  }

  removeBuilding(index: number): void {
    if (this.state.buildings[index] === undefined) throw new RangeError(`no building ${index}`);
    this.commit({
      ...this.state,
      buildings: this.state.buildings.filter((_, i) => i !== index),
    });
  }

  removeSpawn(index: number): void {
    this.removePoint('spawns', index);
  }

  removeDestination(index: number): void {
    this.removePoint('destinations', index);
  }

  removeLandmark(index: number): void {
    this.removePoint('landmarks', index);
  }

  removeDemandAnchor(index: number): void {
    if (this.state.demandAnchors[index] === undefined) throw new RangeError(`no anchor ${index}`);
    this.commit({
      ...this.state,
      demandAnchors: this.state.demandAnchors.filter((_, i) => i !== index),
    });
  }

  private removePoint(key: 'spawns' | 'destinations' | 'landmarks', index: number): void {
    const list = this.state[key];
    if (list[index] === undefined) throw new RangeError(`no ${key} entry ${index}`);
    this.commit({ ...this.state, [key]: list.filter((_, i) => i !== index) });
  }

  /**
   * Remove a name and repair every reference to it.
   *
   * The same hazard as {@link removeNode}, one level subtler: a name index that
   * shifts turns "Cannon Street" into "Ludgate Hill" on a sign, and every
   * structural check still passes. References to the removed name become
   * `undefined` — unnamed — rather than pointing somewhere arbitrary.
   */
  removeName(index: number): void {
    if (this.state.names[index] === undefined) throw new RangeError(`no name ${index}`);

    const repair = <T extends { name?: number }>(item: T): T => {
      if (item.name === undefined) return item;
      if (item.name === index) {
        const { name: _dropped, ...rest } = item;
        return rest as T;
      }
      return item.name > index ? ({ ...item, name: item.name - 1 } as T) : item;
    };

    this.commit({
      ...this.state,
      names: this.state.names.filter((_, i) => i !== index),
      nodes: this.state.nodes.map(repair),
      spawns: this.state.spawns.map(repair),
      destinations: this.state.destinations.map(repair),
      landmarks: this.state.landmarks.map(repair),
    });
  }

  // -------------------------------------------------------------------------
  // Editing in place
  // -------------------------------------------------------------------------

  /** Move a junction. Roads follow, because they reference it by index. */
  moveNode(index: number, x: number, y: number): void {
    if (this.state.nodes[index] === undefined) throw new RangeError(`no junction ${index}`);
    this.commit({
      ...this.state,
      nodes: this.state.nodes.map((node, i) => (i === index ? { ...node, x, y } : node)),
    });
  }

  /** Change a road's width or flags — the "manual override" of `W-02`'s brief. */
  updateEdge(index: number, changes: Partial<Omit<CityEdge, 'a' | 'b'>>): void {
    if (this.state.edges[index] === undefined) throw new RangeError(`no road ${index}`);
    this.commit({
      ...this.state,
      edges: this.state.edges.map((edge, i) => (i === index ? { ...edge, ...changes } : edge)),
    });
  }

  /**
   * Split a road at a point, inserting a junction.
   *
   * The operation an editor needs constantly and the one most likely to lose a
   * property: the two halves inherit the original's width **and flags**, so
   * splitting a one-way leaves two one-ways pointing the same way rather than
   * silently opening it in both directions.
   *
   * @returns the new junction's index.
   */
  splitEdge(index: number, x: number, y: number): number {
    const edge = this.state.edges[index];
    if (edge === undefined) throw new RangeError(`no road ${index}`);

    const nodeIndex = this.state.nodes.length;
    const halves: CityEdge[] = [
      { ...edge, a: edge.a, b: nodeIndex },
      { ...edge, a: nodeIndex, b: edge.b },
    ];

    this.commit({
      ...this.state,
      nodes: [...this.state.nodes, { x, y }],
      edges: [...this.state.edges.filter((_, i) => i !== index), ...halves],
    });
    return nodeIndex;
  }

  // -------------------------------------------------------------------------
  // Output
  // -------------------------------------------------------------------------

  /** Playability findings for the city as it stands. */
  audit(): Finding[] {
    return audit(this.state);
  }

  /**
   * Export, refusing to write a city the game cannot load.
   *
   * `W-02`'s done-when is *"loaded by the game with zero hand-editing"*, so the
   * export path runs both checks the game will run — `validateCity` for
   * structure and `audit` for playability — and packs the city, which is the
   * only way to be sure the bytes the game reads are the bytes this produces.
   */
  export(): { readonly json: CityJson; readonly findings: Finding[] } {
    const findings = this.audit();
    if (!isPlayable(findings)) {
      throw new CityExportError('the city has errors that would make it unplayable', findings);
    }
    // Throws if the city is structurally invalid. Packing here rather than
    // trusting the JSON is what makes "zero hand-editing" checkable.
    validateCity(packCity(this.state));
    return { json: this.state, findings };
  }

  /** Serialise for the download button. Stable key order, so diffs are readable. */
  toJsonText(): string {
    return `${JSON.stringify(this.state, null, 2)}\n`;
  }
}

export class CityExportError extends Error {
  readonly findings: readonly Finding[];

  constructor(message: string, findings: readonly Finding[]) {
    super(message);
    this.name = 'CityExportError';
    this.findings = findings;
  }
}
