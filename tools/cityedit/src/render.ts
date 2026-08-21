/**
 * `render.ts` — drawing the city being edited.
 *
 * Uses `@deadhead/client`'s {@link applyCamera} rather than its own transform.
 * That is the point of `W-02`'s "reuses the game renderer": a second copy of
 * the world/screen maths here would drift from the game's, and the editor would
 * slowly stop showing what the game shows. It is also why the transform lives
 * in `render/viewport.ts` and not inside `camera.ts`.
 *
 * What it does *not* reuse is `renderScene`. That draws a running world — cars,
 * passengers, particles — from two interpolated sim states. The editor draws a
 * *city*: the static geometry plus authoring affordances (junction handles,
 * one-way arrows, selection, the grid) that have no place in the game. Sharing
 * the transform and not the layers is the right seam.
 */
import { applyCamera, type ViewportState } from '@deadhead/client';
import { EdgeFlags, type CityJson } from '@deadhead/proto';

import type { Subject } from './audit.js';
import type { Point } from './picking.js';

const Ink = {
  background: '#14161a',
  grid: '#1e242c',
  gridMajor: '#2a323d',
  road: '#39414d',
  roadEdge: '#4a5462',
  building: '#232a33',
  buildingEdge: '#333c48',
  node: '#8b95a5',
  spawn: '#3fb27f',
  destination: '#4a9eff',
  landmark: '#c58af9',
  anchor: '#ffb454',
  selection: '#f0c419',
  pending: '#f0c419',
} as const;

export interface DrawOptions {
  readonly view: ViewportState;
  readonly city: CityJson;
  readonly selection: Subject | null;
  /** Road tool: the junction a road is being drawn from. */
  readonly pendingNode: number | null;
  /** Building tool: the first corner placed. */
  readonly pendingCorner: Point | null;
  /** Where the cursor is, in world units. */
  readonly cursor: Point | null;
  readonly grid: number;
}

export function draw(context: CanvasRenderingContext2D, options: DrawOptions): void {
  const { view, city } = options;

  context.save();
  context.fillStyle = Ink.background;
  context.fillRect(0, 0, view.width, view.height);

  applyCamera(context, view);

  // World-space line widths shrink with zoom, so every stroke below divides by
  // the scale to stay a constant thickness on screen. A one-unit road outline
  // would be invisible zoomed out and enormous zoomed in.
  const scale = view.zoom * view.pixelsPerUnit;
  const px = 1 / scale;

  drawGrid(context, options, px);
  drawBuildings(context, city, options, px);
  drawRoads(context, city, options, px, scale);
  drawMarkers(context, city, options, px);
  drawNodes(context, city, options, px);
  drawPending(context, options, px);

  context.restore();
}

function drawGrid(context: CanvasRenderingContext2D, options: DrawOptions, px: number): void {
  const { view, grid } = options;
  if (grid <= 0) return;

  const scale = view.zoom * view.pixelsPerUnit;
  // Below about four pixels a grid line is noise rather than guidance.
  if (grid * scale < 4) return;

  const halfW = view.width / 2 / scale;
  const halfH = view.height / 2 / scale;
  // Generous margin so a rotated view still has grid in its corners.
  const reach = Math.hypot(halfW, halfH) + grid;

  const minX = Math.floor((view.x - reach) / grid) * grid;
  const maxX = Math.ceil((view.x + reach) / grid) * grid;
  const minY = Math.floor((view.y - reach) / grid) * grid;
  const maxY = Math.ceil((view.y + reach) / grid) * grid;

  context.lineWidth = px;
  for (let x = minX; x <= maxX; x += grid) {
    context.strokeStyle = x % (grid * 10) === 0 ? Ink.gridMajor : Ink.grid;
    context.beginPath();
    context.moveTo(x, minY);
    context.lineTo(x, maxY);
    context.stroke();
  }
  for (let y = minY; y <= maxY; y += grid) {
    context.strokeStyle = y % (grid * 10) === 0 ? Ink.gridMajor : Ink.grid;
    context.beginPath();
    context.moveTo(minX, y);
    context.lineTo(maxX, y);
    context.stroke();
  }
}

function drawBuildings(
  context: CanvasRenderingContext2D,
  city: CityJson,
  options: DrawOptions,
  px: number,
): void {
  context.lineWidth = px;
  for (let i = 0; i < city.buildings.length; i += 1) {
    const box = city.buildings[i]!;
    const w = box.maxX - box.minX;
    const h = box.maxY - box.minY;

    context.fillStyle = Ink.building;
    context.fillRect(box.minX, box.minY, w, h);
    context.strokeStyle = isSelected(options, 'building', i) ? Ink.selection : Ink.buildingEdge;
    context.lineWidth = isSelected(options, 'building', i) ? px * 2 : px;
    context.strokeRect(box.minX, box.minY, w, h);
  }
}

function drawRoads(
  context: CanvasRenderingContext2D,
  city: CityJson,
  options: DrawOptions,
  px: number,
  scale: number,
): void {
  for (let i = 0; i < city.edges.length; i += 1) {
    const edge = city.edges[i]!;
    const a = city.nodes[edge.a];
    const b = city.nodes[edge.b];
    if (a === undefined || b === undefined) continue;

    // The carriageway, drawn at its authored width so the author sees the road
    // the sim will collide against rather than a nominal centreline.
    context.strokeStyle = isSelected(options, 'edge', i) ? Ink.selection : Ink.road;
    context.lineWidth = edge.width;
    context.lineCap = 'butt';
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.stroke();

    context.strokeStyle = Ink.roadEdge;
    context.lineWidth = px;
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.stroke();

    if (((edge.flags ?? 0) & EdgeFlags.OneWay) !== 0) {
      drawOneWayArrows(context, a, b, edge.width, px, scale);
    }
  }
}

/**
 * Direction arrows along a one-way street.
 *
 * Not decoration. A one-way pointing the wrong way makes a region a cab can
 * enter and never leave — `audit`'s strong-connectivity rule reports it, but by
 * then the author has to work out *which* street. Drawing the direction is the
 * difference between finding that in the editor and finding it in a report.
 */
function drawOneWayArrows(
  context: CanvasRenderingContext2D,
  a: { x: number; y: number },
  b: { x: number; y: number },
  width: number,
  px: number,
  scale: number,
): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return;

  const ux = dx / length;
  const uy = dy / length;
  const size = Math.max(width * 0.35, 6 / scale);
  const spacing = Math.max(size * 4, 24 / scale);

  context.strokeStyle = Ink.roadEdge;
  context.lineWidth = px * 1.5;
  context.lineCap = 'round';

  for (let d = spacing / 2; d < length; d += spacing) {
    const x = a.x + ux * d;
    const y = a.y + uy * d;
    context.beginPath();
    context.moveTo(x - ux * size - uy * size * 0.6, y - uy * size + ux * size * 0.6);
    context.lineTo(x, y);
    context.lineTo(x - ux * size + uy * size * 0.6, y - uy * size - ux * size * 0.6);
    context.stroke();
  }
}

function drawMarkers(
  context: CanvasRenderingContext2D,
  city: CityJson,
  options: DrawOptions,
  px: number,
): void {
  const scale = options.view.zoom * options.view.pixelsPerUnit;
  const r = 5 / scale;

  const dot = (point: { x: number; y: number }, colour: string, selected: boolean): void => {
    context.fillStyle = colour;
    context.beginPath();
    context.arc(point.x, point.y, r, 0, Math.PI * 2);
    context.fill();
    if (selected) {
      context.strokeStyle = Ink.selection;
      context.lineWidth = px * 2;
      context.stroke();
    }
  };

  city.demandAnchors.forEach((anchor, i) => {
    // The influence radius, drawn, because a demand anchor's radius is
    // impossible to judge from a number in a panel.
    context.strokeStyle = Ink.anchor;
    context.globalAlpha = 0.25;
    context.lineWidth = px;
    context.beginPath();
    context.arc(anchor.x, anchor.y, Math.max(anchor.radius, 0), 0, Math.PI * 2);
    context.stroke();
    context.globalAlpha = 1;
    dot(anchor, Ink.anchor, isSelected(options, 'anchor', i));
  });

  city.spawns.forEach((p, i) => dot(p, Ink.spawn, isSelected(options, 'spawn', i)));
  city.destinations.forEach((p, i) =>
    dot(p, Ink.destination, isSelected(options, 'destination', i)),
  );
  city.landmarks.forEach((p, i) => dot(p, Ink.landmark, isSelected(options, 'landmark', i)));
}

function drawNodes(
  context: CanvasRenderingContext2D,
  city: CityJson,
  options: DrawOptions,
  px: number,
): void {
  const scale = options.view.zoom * options.view.pixelsPerUnit;
  const r = 4 / scale;

  for (let i = 0; i < city.nodes.length; i += 1) {
    const node = city.nodes[i]!;
    const selected = isSelected(options, 'node', i);
    const pending = options.pendingNode === i;

    context.fillStyle = pending ? Ink.pending : Ink.node;
    context.beginPath();
    context.arc(node.x, node.y, r, 0, Math.PI * 2);
    context.fill();

    if (selected) {
      context.strokeStyle = Ink.selection;
      context.lineWidth = px * 2;
      context.beginPath();
      context.arc(node.x, node.y, r * 2, 0, Math.PI * 2);
      context.stroke();
    }
  }
}

/**
 * The half-finished action, shown as it will land.
 *
 * A road tool that shows nothing between the two clicks is a tool you have to
 * guess at. Both previews are drawn from the same snapped values the click will
 * use, so what is previewed is what is committed.
 */
function drawPending(context: CanvasRenderingContext2D, options: DrawOptions, px: number): void {
  const { cursor, city, pendingNode, pendingCorner } = options;
  if (cursor === null) return;

  context.save();
  context.strokeStyle = Ink.pending;
  context.lineWidth = px * 1.5;
  context.setLineDash([px * 6, px * 4]);

  if (pendingNode !== null) {
    const from = city.nodes[pendingNode];
    if (from !== undefined) {
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(cursor.x, cursor.y);
      context.stroke();
    }
  }

  if (pendingCorner !== null) {
    context.strokeRect(
      Math.min(pendingCorner.x, cursor.x),
      Math.min(pendingCorner.y, cursor.y),
      Math.abs(cursor.x - pendingCorner.x),
      Math.abs(cursor.y - pendingCorner.y),
    );
  }

  context.restore();
}

function isSelected(options: DrawOptions, kind: Subject['kind'], index: number): boolean {
  return options.selection?.kind === kind && options.selection.index === index;
}
