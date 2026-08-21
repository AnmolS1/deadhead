/**
 * `tools.ts` — what a click means.
 *
 * The editor's tool state machine, kept separate from the canvas so it is
 * testable without a browser. Every tool is a small state machine over
 * {@link CityDocument}, and the interesting ones are the two that need more
 * than one click.
 *
 * ## The two bugs this is shaped to avoid
 *
 * **A box drawn backwards.** Drag a building from its bottom-right corner to
 * its top-left and the raw result has `minX > maxX`. Left alone that is
 * inverted geometry — `validateCity` rejects it eventually, a long way from the
 * click that caused it. {@link normaliseBox} sorts the corners so a drag in any
 * of the four directions produces the same rectangle.
 *
 * **A junction that does not connect.** When the road tool is asked for a point
 * near an existing junction, it must *use that junction* rather than create a
 * second one beside it. Two junctions a unit apart are indistinguishable on
 * screen and produce a city where two roads cross with no connection between
 * them — an `unreachable` finding whose cause is invisible. `snap()` already
 * puts existing junctions ahead of the grid; this layer has to honour that
 * answer rather than re-deriving a point of its own.
 */
import type { CityBox } from '@deadhead/proto';

import { CityDocument } from './document.js';
import type { Subject } from './audit.js';
import { pick, snap, snapKerb, type Point, type SnapOptions } from './picking.js';

export type ToolKind =
  'select' | 'road' | 'building' | 'spawn' | 'destination' | 'landmark' | 'anchor' | 'erase';

/** Everything the editor remembers between clicks. */
export interface ToolState {
  readonly tool: ToolKind;
  /** What is selected, for the properties panel. */
  readonly selection: Subject | null;
  /** Road tool: the junction the next road starts from. */
  readonly pendingNode: number | null;
  /** Building tool: the first corner placed. */
  readonly pendingCorner: Point | null;
  /** Shown under the cursor, so a half-finished action is never a mystery. */
  readonly hint: string;
}

export function initialToolState(tool: ToolKind = 'select'): ToolState {
  return { tool, selection: null, pendingNode: null, pendingCorner: null, hint: '' };
}

/**
 * Switch tools, abandoning anything half-finished.
 *
 * Carrying a pending corner across a tool change is how an editor ends up
 * drawing a building between two points the author chose for different reasons.
 */
export function selectTool(state: ToolState, tool: ToolKind): ToolState {
  return { ...initialToolState(tool), selection: state.selection };
}

/** Abandon a half-finished action, keeping the tool. Bound to Escape. */
export function cancel(state: ToolState): ToolState {
  return { ...state, pendingNode: null, pendingCorner: null, hint: '' };
}

export interface ClickContext {
  /** Pick radius in world units — derived from zoom by `toleranceForZoom`. */
  readonly tolerance: number;
  readonly snapOptions?: Partial<SnapOptions>;
}

/**
 * Apply a click at a world-space point.
 *
 * Mutates `doc` through its operations (so undo covers everything) and returns
 * the next tool state. Never throws for ordinary misuse — clicking empty space
 * with the erase tool is a no-op, not an error.
 */
export function click(
  doc: CityDocument,
  state: ToolState,
  at: Point,
  context: ClickContext,
): ToolState {
  switch (state.tool) {
    case 'select': {
      const hit = pick(doc.city, at, context.tolerance);
      return { ...state, selection: hit === null ? null : { kind: hit.kind, index: hit.index } };
    }

    case 'road':
      return clickRoad(doc, state, at, context);

    case 'building':
      return clickBuilding(doc, state, at, context);

    // Spawns and destinations are people, so they snap to the KERB rather than
    // to the road centreline the general snap() prefers. See snapKerb.
    case 'spawn': {
      const kerb = snapKerb(doc.city, at, 'spawn', context.snapOptions);
      const index = doc.addSpawn(kerb.point);
      return {
        ...state,
        selection: { kind: 'spawn', index },
        hint: kerb.onKerb ? '' : 'No road near enough to stand beside.',
      };
    }

    case 'destination': {
      const kerb = snapKerb(doc.city, at, 'destination', context.snapOptions);
      const index = doc.addDestination(kerb.point);
      return {
        ...state,
        selection: { kind: 'destination', index },
        hint: kerb.onKerb ? '' : 'No road near enough to stand beside.',
      };
    }

    case 'landmark': {
      const point = snap(doc.city, at, context.snapOptions).point;
      const index = doc.addLandmark(point);
      return { ...state, selection: { kind: 'landmark', index } };
    }

    case 'anchor': {
      const point = snap(doc.city, at, context.snapOptions).point;
      const index = doc.addDemandAnchor({ ...point, radius: 80 });
      return { ...state, selection: { kind: 'anchor', index } };
    }

    case 'erase':
      return clickErase(doc, state, at, context);

    default: {
      const exhaustive: never = state.tool;
      throw new Error(`unhandled tool: ${String(exhaustive)}`);
    }
  }
}

/**
 * Resolve a click to a junction index, creating or splitting as needed.
 *
 * The three cases, in the order that matters:
 *
 * 1. **On an existing junction** — use it. This is the case that must come
 *    first, or roads stop connecting to each other.
 * 2. **On a road** — split it, so the new junction is genuinely part of that
 *    road rather than a separate one lying on top of it.
 * 3. **Anywhere else** — a new junction at the snapped point.
 */
function resolveJunction(doc: CityDocument, at: Point, context: ClickContext): number {
  const target = snap(doc.city, at, context.snapOptions);

  if (target.to === 'node' && target.index !== undefined) return target.index;
  if (target.to === 'edge' && target.index !== undefined) {
    return doc.splitEdge(target.index, target.point.x, target.point.y);
  }
  return doc.addNode(target.point);
}

function clickRoad(
  doc: CityDocument,
  state: ToolState,
  at: Point,
  context: ClickContext,
): ToolState {
  const junction = resolveJunction(doc, at, context);

  if (state.pendingNode === null) {
    return {
      ...state,
      pendingNode: junction,
      selection: { kind: 'node', index: junction },
      hint: 'Click again to finish the road. Escape cancels.',
    };
  }

  if (state.pendingNode === junction) {
    // Clicking the same junction twice is how you cancel without reaching for
    // Escape. Silently doing nothing would look like the tool had broken.
    return { ...state, pendingNode: null, hint: 'Road cancelled.' };
  }

  try {
    doc.addEdge({ a: state.pendingNode, b: junction, width: 8 });
  } catch (error) {
    // A duplicate road is the common case and is not worth an exception
    // reaching the UI. Carry on from the new junction, which is what someone
    // drawing a chain of roads means.
    return {
      ...state,
      pendingNode: junction,
      hint: error instanceof Error ? error.message : 'Could not add that road.',
    };
  }

  // Chain: the road just drawn becomes the start of the next one, so a street
  // is one click per junction rather than two.
  return {
    ...state,
    pendingNode: junction,
    selection: { kind: 'node', index: junction },
    hint: 'Road added. Click to continue the chain, Escape to stop.',
  };
}

function clickBuilding(
  doc: CityDocument,
  state: ToolState,
  at: Point,
  context: ClickContext,
): ToolState {
  const corner = snap(doc.city, at, context.snapOptions).point;

  if (state.pendingCorner === null) {
    return { ...state, pendingCorner: corner, hint: 'Click the opposite corner. Escape cancels.' };
  }

  const box = normaliseBox(state.pendingCorner, corner);
  if (box === null) {
    return { ...state, pendingCorner: null, hint: 'That building would have no area.' };
  }

  const index = doc.addBuilding(box);
  return {
    ...state,
    pendingCorner: null,
    selection: { kind: 'building', index },
    hint: '',
  };
}

/**
 * Two corners into a rectangle, whichever way round they were given.
 *
 * `null` when the two corners share a row or column, because a building with no
 * area is not a building — and `addBuilding` would reject it anyway, with an
 * exception the UI would have to catch.
 */
export function normaliseBox(a: Point, b: Point): CityBox | null {
  const box: CityBox = {
    minX: Math.min(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x),
    maxY: Math.max(a.y, b.y),
  };
  if (box.maxX <= box.minX || box.maxY <= box.minY) return null;
  return box;
}

function clickErase(
  doc: CityDocument,
  state: ToolState,
  at: Point,
  context: ClickContext,
): ToolState {
  const hit = pick(doc.city, at, context.tolerance);
  if (hit === null) return { ...state, hint: 'Nothing there.' };

  switch (hit.kind) {
    case 'node':
      doc.removeNode(hit.index);
      break;
    case 'edge':
      doc.removeEdge(hit.index);
      break;
    case 'building':
      doc.removeBuilding(hit.index);
      break;
    case 'spawn':
      doc.removeSpawn(hit.index);
      break;
    case 'destination':
      doc.removeDestination(hit.index);
      break;
    case 'landmark':
      doc.removeLandmark(hit.index);
      break;
    case 'anchor':
      doc.removeDemandAnchor(hit.index);
      break;
  }

  // The selection is an index into a list that just shifted, so holding onto it
  // would leave the properties panel describing a different object. Clearing it
  // is the only safe answer.
  return { ...state, selection: null, hint: `Removed ${hit.kind}.` };
}
