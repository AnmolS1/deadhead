import { describe, expect, it } from 'vitest';

import { EdgeFlags, emptyCityJson, packCity } from '@deadhead/proto';
import { prepareCity } from '@deadhead/sim';

import { CityDocument, CityExportError } from '../src/document.js';

/** A document with a square block already drawn, ready to be edited. */
function squareDocument(): CityDocument {
  const doc = new CityDocument(emptyCityJson('test'));
  doc.addNode({ x: 0, y: 0 });
  doc.addNode({ x: 200, y: 0 });
  doc.addNode({ x: 200, y: 200 });
  doc.addNode({ x: 0, y: 200 });
  doc.addEdge({ a: 0, b: 1, width: 8 });
  doc.addEdge({ a: 1, b: 2, width: 8 });
  doc.addEdge({ a: 2, b: 3, width: 8 });
  doc.addEdge({ a: 3, b: 0, width: 8 });
  doc.addSpawn({ x: 10, y: 4 });
  doc.addDestination({ x: 190, y: 196 });
  return doc;
}

// ---------------------------------------------------------------------------

describe('adding', () => {
  it('returns the index of what it added', () => {
    const doc = new CityDocument();
    expect(doc.addNode({ x: 0, y: 0 })).toBe(0);
    expect(doc.addNode({ x: 10, y: 0 })).toBe(1);
    expect(doc.addEdge({ a: 0, b: 1, width: 8 })).toBe(0);
  });

  it('refuses a road from a junction to itself', () => {
    // validateCity rejects self-loops, so catching it here means the editor
    // cannot author a city that fails to load.
    const doc = new CityDocument();
    doc.addNode({ x: 0, y: 0 });
    expect(() => doc.addEdge({ a: 0, b: 0, width: 8 })).toThrow(/itself/);
  });

  it('refuses a road to a junction that does not exist', () => {
    const doc = new CityDocument();
    doc.addNode({ x: 0, y: 0 });
    expect(() => doc.addEdge({ a: 0, b: 9, width: 8 })).toThrow(/does not exist/);
  });

  it('refuses a duplicate road, in either direction', () => {
    const doc = squareDocument();
    expect(() => doc.addEdge({ a: 0, b: 1, width: 8 })).toThrow(/already connects/);
    expect(() => doc.addEdge({ a: 1, b: 0, width: 8 })).toThrow(/already connects/);
  });

  it('refuses a degenerate building', () => {
    const doc = new CityDocument();
    expect(() => doc.addBuilding({ minX: 5, minY: 0, maxX: 5, maxY: 10 })).toThrow(/positive/);
  });

  it('reuses an existing name rather than duplicating it', () => {
    const doc = new CityDocument();
    expect(doc.addName('Cannon Street')).toBe(0);
    expect(doc.addName('Cannon Street')).toBe(0);
    expect(doc.city.names).toHaveLength(1);
  });
});

describe('removal renumbers every reference', () => {
  it('keeps the surviving roads connecting the same junctions', () => {
    // THE bug this module exists to prevent. CityJson addresses everything by
    // index, so deleting junction 1 leaves every edge that referenced junction
    // 3 pointing at junction 2. The city still validates, audit still passes,
    // and the roads have quietly moved — plausible output, which is the worst
    // shape a bug can take.
    //
    // Asserted by identity, not by index: whatever the numbering ends up being,
    // the road that joined (200,200) to (0,200) must still join those two
    // points.
    const doc = squareDocument();
    const before = doc.city.edges.map((edge) => ({
      a: doc.city.nodes[edge.a]!,
      b: doc.city.nodes[edge.b]!,
    }));

    doc.removeNode(1); // (200, 0)

    const after = doc.city.edges.map((edge) => ({
      a: doc.city.nodes[edge.a]!,
      b: doc.city.nodes[edge.b]!,
    }));

    // The two roads that touched junction 1 are gone; the other two survive
    // joining exactly the same coordinates.
    const survivors = before.filter(
      (road) => !(road.a.x === 200 && road.a.y === 0) && !(road.b.x === 200 && road.b.y === 0),
    );
    expect(after).toEqual(survivors);
    expect(after).toHaveLength(2);
  });

  it('leaves no edge pointing past the end of the node list', () => {
    const doc = squareDocument();
    doc.removeNode(0);
    for (const edge of doc.city.edges) {
      expect(doc.city.nodes[edge.a]).toBeDefined();
      expect(doc.city.nodes[edge.b]).toBeDefined();
    }
  });

  it('removes the roads that ran through the junction', () => {
    const doc = squareDocument();
    expect(doc.city.edges).toHaveLength(4);
    doc.removeNode(1);
    expect(doc.city.edges).toHaveLength(2);
  });

  it('still packs and loads after a deletion', () => {
    // The end-to-end guarantee: a renumbering mistake shows up here as a throw
    // from validateCity rather than as a city that is subtly wrong.
    const doc = squareDocument();
    doc.removeNode(2);
    expect(() => prepareCity(packCity(doc.city))).not.toThrow();
  });

  it('rejects removing something that is not there', () => {
    const doc = squareDocument();
    expect(() => doc.removeNode(99)).toThrow(/no junction/);
    expect(() => doc.removeEdge(99)).toThrow(/no road/);
  });
});

describe('removing a name repairs the references', () => {
  it('shifts higher indices down', () => {
    // One level subtler than the node case and just as damaging: a name index
    // that shifts turns "Cannon Street" into "Ludgate Hill" on a sign, and
    // every structural check still passes.
    const doc = new CityDocument();
    doc.addName('Cannon Street'); // 0
    doc.addName('Ludgate Hill'); // 1
    doc.addName('Fleet Street'); // 2
    doc.addNode({ x: 0, y: 0, name: 2 });

    doc.removeName(0);

    expect(doc.city.names).toEqual(['Ludgate Hill', 'Fleet Street']);
    expect(doc.city.nodes[0]?.name).toBe(1);
    expect(doc.city.names[doc.city.nodes[0]!.name!]).toBe('Fleet Street');
  });

  it('unnames whatever referenced the removed name', () => {
    // Rather than leaving it pointing somewhere arbitrary.
    const doc = new CityDocument();
    doc.addName('Cannon Street');
    doc.addSpawn({ x: 0, y: 0, name: 0 });

    doc.removeName(0);

    expect(doc.city.spawns[0]?.name).toBeUndefined();
    expect('name' in doc.city.spawns[0]!).toBe(false);
  });

  it('leaves lower indices alone', () => {
    const doc = new CityDocument();
    doc.addName('A');
    doc.addName('B');
    doc.addLandmark({ x: 0, y: 0, name: 0 });
    doc.removeName(1);
    expect(doc.city.landmarks[0]?.name).toBe(0);
  });
});

describe('splitting a road', () => {
  it('replaces one road with two that meet at the new junction', () => {
    const doc = squareDocument();
    const created = doc.splitEdge(0, 100, 0);

    expect(doc.city.nodes[created]).toEqual({ x: 100, y: 0 });
    expect(doc.city.edges).toHaveLength(5);

    const halves = doc.city.edges.filter((e) => e.a === created || e.b === created);
    expect(halves).toHaveLength(2);
  });

  it('carries the one-way flag onto both halves, pointing the same way', () => {
    // The property most likely to be lost. Splitting a one-way must not
    // silently open it in both directions — that would create exactly the
    // trap audit()'s strong-connectivity rule exists to catch, from an
    // operation the author thought was cosmetic.
    const doc = squareDocument();
    doc.updateEdge(0, { flags: EdgeFlags.OneWay });
    const created = doc.splitEdge(0, 100, 0);

    const halves = doc.city.edges.filter((e) => e.a === created || e.b === created);
    expect(halves).toHaveLength(2);
    for (const half of halves) {
      expect(half.flags! & EdgeFlags.OneWay).toBe(EdgeFlags.OneWay);
    }
    // And in the original direction: 0 -> new -> 1.
    expect(halves.find((h) => h.b === created)?.a).toBe(0);
    expect(halves.find((h) => h.a === created)?.b).toBe(1);
  });

  it('carries the width across', () => {
    const doc = squareDocument();
    doc.updateEdge(0, { width: 14 });
    const created = doc.splitEdge(0, 100, 0);
    for (const half of doc.city.edges.filter((e) => e.a === created || e.b === created)) {
      expect(half.width).toBe(14);
    }
  });

  it('leaves the city loadable', () => {
    const doc = squareDocument();
    doc.splitEdge(2, 100, 200);
    expect(() => prepareCity(packCity(doc.city))).not.toThrow();
  });
});

describe('undo and redo', () => {
  it('reverses the last change', () => {
    const doc = squareDocument();
    const before = doc.city;
    doc.addNode({ x: 500, y: 500 });
    expect(doc.city.nodes).toHaveLength(5);

    expect(doc.undo()).toBe(true);
    expect(doc.city).toBe(before);
    expect(doc.city.nodes).toHaveLength(4);
  });

  it('covers every operation, because they all go through one path', () => {
    // Snapshot-based rather than command-with-inverse, so a new operation needs
    // no undo support and cannot be forgotten. This walks the whole surface.
    const doc = squareDocument();
    const start = doc.city;

    const operations = [
      () => doc.addBuilding({ minX: 0, minY: 0, maxX: 10, maxY: 10 }),
      () => doc.addLandmark({ x: 5, y: 5 }),
      () => doc.addDemandAnchor({ x: 5, y: 5, radius: 20 }),
      () => doc.moveNode(0, 1, 1),
      () => doc.updateEdge(0, { width: 20 }),
      () => doc.splitEdge(1, 200, 100),
      () => doc.removeNode(0),
      () => doc.addName('Fleet Street'),
    ];
    for (const operation of operations) operation();

    // Exactly as many undos as operations — NOT `while (canUndo)`, which
    // rewinds past this fixture's own construction to the empty city and
    // "passes" for the wrong reason. One undo per operation is what proves
    // every operation recorded exactly one history entry.
    for (let i = 0; i < operations.length; i += 1) expect(doc.undo()).toBe(true);
    expect(doc.city).toBe(start);
  });

  it('redoes what it undid', () => {
    const doc = squareDocument();
    doc.addNode({ x: 500, y: 500 });
    const after = doc.city;

    doc.undo();
    expect(doc.redo()).toBe(true);
    expect(doc.city).toBe(after);
  });

  it('drops the redo branch once a new edit lands', () => {
    // As in every editor: undo, then do something else, and the old future is
    // gone. Keeping it would let redo splice in a change made against a state
    // that no longer exists.
    const doc = squareDocument();
    doc.addNode({ x: 500, y: 500 });
    doc.undo();
    expect(doc.canRedo).toBe(true);

    doc.addNode({ x: 900, y: 900 });
    expect(doc.canRedo).toBe(false);
  });

  it('reports rather than throws at the ends of the history', () => {
    const doc = new CityDocument();
    expect(doc.canUndo).toBe(false);
    expect(doc.undo()).toBe(false);
    expect(doc.redo()).toBe(false);
  });

  it('keeps history bounded', () => {
    const doc = new CityDocument(emptyCityJson(), 5);
    for (let i = 0; i < 50; i += 1) doc.addNode({ x: i, y: 0 });

    let undos = 0;
    while (doc.undo()) undos += 1;
    expect(undos).toBe(5);
    // The oldest states were dropped, so it does not rewind to empty.
    expect(doc.city.nodes.length).toBeGreaterThan(0);
  });

  it('rejects a nonsense history limit', () => {
    expect(() => new CityDocument(emptyCityJson(), 0)).toThrow(RangeError);
  });
});

describe('export', () => {
  it('produces a city the game loads, with no hand-editing', () => {
    // W-02's done-when, stated as a test: author in the tool, export, and the
    // game's own loader accepts it.
    const doc = squareDocument();
    const { json } = doc.export();

    const runtime = prepareCity(packCity(json));
    expect(runtime.packed.nodes.length).toBeGreaterThan(0);
    expect(runtime.nav.nodeExitStart.length).toBe(json.nodes.length + 1);
  });

  it('refuses to export a city with errors', () => {
    const doc = new CityDocument(emptyCityJson('broken'));
    expect(() => doc.export()).toThrow(CityExportError);
  });

  it('attaches the findings to the refusal, so the editor can show them', () => {
    const doc = new CityDocument(emptyCityJson('broken'));
    try {
      doc.export();
      expect.unreachable('export should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CityExportError);
      expect((error as CityExportError).findings.map((f) => f.rule)).toContain('no-spawns');
    }
  });

  it('exports despite warnings, which are advice rather than blockers', () => {
    const doc = squareDocument();
    doc.addNode({ x: 400, y: 100 });
    doc.addEdge({ a: 1, b: 4, width: 8 }); // a cul-de-sac: dead-end warning
    const { findings } = doc.export();
    expect(findings.some((f) => f.rule === 'dead-end')).toBe(true);
  });

  it('serialises to stable, readable JSON', () => {
    const doc = squareDocument();
    const text = doc.toJsonText();
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual(doc.city);
  });
});
