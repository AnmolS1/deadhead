import { describe, expect, it } from 'vitest';

import { emptyCityJson } from '@deadhead/proto';

import { CityDocument } from '../src/document.js';
import {
  cancel,
  click,
  initialToolState,
  normaliseBox,
  selectTool,
  type ToolState,
} from '../src/tools.js';

const ctx = { tolerance: 6 };

function fresh(): { doc: CityDocument; state: ToolState } {
  return { doc: new CityDocument(emptyCityJson('t')), state: initialToolState() };
}

// ---------------------------------------------------------------------------

describe('the road tool', () => {
  it('takes two clicks to make a road', () => {
    const { doc } = fresh();
    let state = selectTool(initialToolState(), 'road');

    state = click(doc, state, { x: 0, y: 0 }, ctx);
    expect(doc.city.nodes).toHaveLength(1);
    expect(doc.city.edges).toHaveLength(0);
    expect(state.pendingNode).toBe(0);

    click(doc, state, { x: 200, y: 0 }, ctx);
    expect(doc.city.nodes).toHaveLength(2);
    expect(doc.city.edges).toHaveLength(1);
  });

  it('chains, so a street is one click per junction', () => {
    const { doc } = fresh();
    let state = selectTool(initialToolState(), 'road');
    for (const x of [0, 100, 200, 300]) {
      state = click(doc, state, { x, y: 0 }, ctx);
    }
    expect(doc.city.nodes).toHaveLength(4);
    expect(doc.city.edges).toHaveLength(3);
  });

  it('connects to an existing junction instead of stacking a new one beside it', () => {
    // THE bug this layer exists to avoid. Two junctions a unit apart are
    // indistinguishable on screen and produce a city where two roads cross with
    // NO connection between them — an `unreachable` finding whose cause the
    // author cannot see. snap() puts existing junctions ahead of the grid; the
    // tool has to honour that answer rather than deriving a point of its own.
    const { doc } = fresh();
    let state = selectTool(initialToolState(), 'road');
    state = click(doc, state, { x: 0, y: 0 }, ctx);
    state = click(doc, state, { x: 200, y: 0 }, ctx);
    state = cancel(state);

    // Start a second road a couple of units from the junction at (200, 0).
    state = click(doc, state, { x: 202, y: 1 }, ctx);
    click(doc, state, { x: 200, y: 200 }, ctx);

    // Three junctions, not four: the near-click reused (200, 0).
    expect(doc.city.nodes).toHaveLength(3);
    expect(doc.city.edges).toHaveLength(2);

    // And the two roads genuinely share a junction.
    const shared = doc.city.edges[0]!.b;
    expect([doc.city.edges[1]!.a, doc.city.edges[1]!.b]).toContain(shared);
  });

  it('splits a road when a new one is started on top of it', () => {
    // So the junction is genuinely part of that road rather than a separate one
    // lying on it — which would look connected and not be.
    const { doc } = fresh();
    let state = selectTool(initialToolState(), 'road');
    state = click(doc, state, { x: 0, y: 0 }, ctx);
    state = click(doc, state, { x: 200, y: 0 }, ctx);
    state = cancel(state);

    state = click(doc, state, { x: 100, y: 0 }, ctx); // mid-road
    expect(doc.city.edges).toHaveLength(2); // the original was split
    expect(doc.city.nodes).toHaveLength(3);

    click(doc, state, { x: 100, y: 150 }, ctx);
    expect(doc.city.edges).toHaveLength(3);
  });

  it('cancels when the same junction is clicked twice', () => {
    const { doc } = fresh();
    let state = selectTool(initialToolState(), 'road');
    state = click(doc, state, { x: 0, y: 0 }, ctx);
    state = click(doc, state, { x: 0, y: 0 }, ctx);

    expect(state.pendingNode).toBeNull();
    expect(doc.city.edges).toHaveLength(0);
    expect(state.hint).toMatch(/cancel/i);
  });

  it('survives a duplicate road without throwing at the UI', () => {
    const { doc } = fresh();
    let state = selectTool(initialToolState(), 'road');
    state = click(doc, state, { x: 0, y: 0 }, ctx);
    state = click(doc, state, { x: 200, y: 0 }, ctx);
    // Chained: pending is now the far junction. Click back to the first.
    state = click(doc, state, { x: 0, y: 0 }, ctx);
    // Now try the same pair again.
    expect(() => click(doc, state, { x: 200, y: 0 }, ctx)).not.toThrow();
    expect(doc.city.edges).toHaveLength(1);
  });
});

describe('the building tool', () => {
  it('takes two corners', () => {
    const { doc } = fresh();
    let state = selectTool(initialToolState(), 'building');

    state = click(doc, state, { x: 0, y: 0 }, ctx);
    expect(doc.city.buildings).toHaveLength(0);
    expect(state.pendingCorner).not.toBeNull();

    state = click(doc, state, { x: 100, y: 60 }, ctx);
    expect(doc.city.buildings).toHaveLength(1);
    expect(state.pendingCorner).toBeNull();
  });

  it('produces the same rectangle whichever way it is dragged', () => {
    // Drag from the bottom-right and the raw result has minX > maxX. Left
    // alone that is inverted geometry, rejected by validateCity a long way from
    // the click that caused it.
    const corners = [
      [
        { x: 0, y: 0 },
        { x: 100, y: 60 },
      ],
      [
        { x: 100, y: 60 },
        { x: 0, y: 0 },
      ],
      [
        { x: 0, y: 60 },
        { x: 100, y: 0 },
      ],
      [
        { x: 100, y: 0 },
        { x: 0, y: 60 },
      ],
    ] as const;

    for (const [a, b] of corners) {
      const { doc } = fresh();
      let state = selectTool(initialToolState(), 'building');
      state = click(doc, state, a, ctx);
      click(doc, state, b, ctx);
      expect(doc.city.buildings[0], `${a.x},${a.y} -> ${b.x},${b.y}`).toEqual({
        minX: 0,
        minY: 0,
        maxX: 100,
        maxY: 60,
      });
    }
  });

  it('refuses a building with no area, and says why', () => {
    const { doc } = fresh();
    let state = selectTool(initialToolState(), 'building');
    state = click(doc, state, { x: 0, y: 0 }, ctx);
    state = click(doc, state, { x: 0, y: 60 }, ctx); // same column

    expect(doc.city.buildings).toHaveLength(0);
    expect(state.hint).toMatch(/no area/i);
    expect(state.pendingCorner).toBeNull();
  });

  it('normalises directly, too', () => {
    expect(normaliseBox({ x: 5, y: 5 }, { x: 1, y: 1 })).toEqual({
      minX: 1,
      minY: 1,
      maxX: 5,
      maxY: 5,
    });
    expect(normaliseBox({ x: 5, y: 5 }, { x: 5, y: 9 })).toBeNull();
  });
});

describe('point tools', () => {
  it('place one thing per click', () => {
    const { doc } = fresh();
    for (const tool of ['spawn', 'destination', 'landmark', 'anchor'] as const) {
      const state = selectTool(initialToolState(), tool);
      click(doc, state, { x: 50, y: 50 }, ctx);
    }
    expect(doc.city.spawns).toHaveLength(1);
    expect(doc.city.destinations).toHaveLength(1);
    expect(doc.city.landmarks).toHaveLength(1);
    expect(doc.city.demandAnchors).toHaveLength(1);
  });

  it('gives a demand anchor a usable radius rather than zero', () => {
    // A zero-radius anchor is an audit error, so the tool must not create one
    // by default and make the author fix it.
    const { doc } = fresh();
    click(doc, selectTool(initialToolState(), 'anchor'), { x: 0, y: 0 }, ctx);
    expect(doc.city.demandAnchors[0]!.radius).toBeGreaterThan(0);
  });
});

describe('the erase tool', () => {
  it('removes what is under the cursor', () => {
    const { doc } = fresh();
    doc.addNode({ x: 0, y: 0 });
    doc.addNode({ x: 200, y: 0 });
    doc.addEdge({ a: 0, b: 1, width: 8 });

    click(doc, selectTool(initialToolState(), 'erase'), { x: 100, y: 0 }, ctx);
    expect(doc.city.edges).toHaveLength(0);
    expect(doc.city.nodes).toHaveLength(2);
  });

  it('is a no-op on empty space rather than an error', () => {
    const { doc } = fresh();
    const state = click(doc, selectTool(initialToolState(), 'erase'), { x: 900, y: 900 }, ctx);
    expect(state.hint).toMatch(/nothing/i);
  });

  it('clears the selection, because every index after it just moved', () => {
    // Holding a stale index would leave the properties panel describing a
    // different object than the one highlighted.
    const { doc } = fresh();
    doc.addSpawn({ x: 0, y: 0 });
    doc.addSpawn({ x: 50, y: 0 });

    let state = selectTool(initialToolState(), 'select');
    state = click(doc, state, { x: 50, y: 0 }, ctx);
    expect(state.selection).toEqual({ kind: 'spawn', index: 1 });

    state = selectTool(state, 'erase');
    state = click(doc, state, { x: 0, y: 0 }, ctx);
    expect(state.selection).toBeNull();
  });
});

describe('tool state', () => {
  it('abandons a half-finished action when the tool changes', () => {
    // Carrying a pending corner across a tool change is how an editor draws a
    // building between two points chosen for different reasons.
    const { doc } = fresh();
    let state = selectTool(initialToolState(), 'building');
    state = click(doc, state, { x: 0, y: 0 }, ctx);
    expect(state.pendingCorner).not.toBeNull();

    state = selectTool(state, 'road');
    expect(state.pendingCorner).toBeNull();
    expect(state.pendingNode).toBeNull();
  });

  it('keeps the selection across a tool change', () => {
    const { doc } = fresh();
    doc.addSpawn({ x: 0, y: 0 });
    let state = click(doc, initialToolState('select'), { x: 0, y: 0 }, ctx);
    state = selectTool(state, 'road');
    expect(state.selection).toEqual({ kind: 'spawn', index: 0 });
  });

  it('cancel keeps the tool but drops the pending action', () => {
    const { doc } = fresh();
    let state = selectTool(initialToolState(), 'road');
    state = click(doc, state, { x: 0, y: 0 }, ctx);
    state = cancel(state);
    expect(state.tool).toBe('road');
    expect(state.pendingNode).toBeNull();
  });

  it('selects nothing when clicking empty space with the select tool', () => {
    const { doc } = fresh();
    doc.addSpawn({ x: 0, y: 0 });
    let state = click(doc, initialToolState('select'), { x: 0, y: 0 }, ctx);
    expect(state.selection).not.toBeNull();
    state = click(doc, state, { x: 900, y: 900 }, ctx);
    expect(state.selection).toBeNull();
  });
});

describe('everything a tool does is undoable', () => {
  it('rewinds a whole authoring session', () => {
    // The operations all go through CityDocument, so undo covers the tools for
    // free. Worth asserting, because a tool that reached into the city directly
    // would silently break that.
    const { doc } = fresh();
    const start = doc.city;

    let state = selectTool(initialToolState(), 'road');
    state = click(doc, state, { x: 0, y: 0 }, ctx);
    state = click(doc, state, { x: 200, y: 0 }, ctx);
    state = selectTool(state, 'building');
    state = click(doc, state, { x: 0, y: 40 }, ctx);
    state = click(doc, state, { x: 80, y: 100 }, ctx);
    state = selectTool(state, 'spawn');
    click(doc, state, { x: 20, y: 4 }, ctx);

    while (doc.canUndo) doc.undo();
    expect(doc.city).toBe(start);
  });
});
