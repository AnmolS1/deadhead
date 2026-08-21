/**
 * `main.ts` — the editor shell.
 *
 * Wiring only. Every decision of substance lives in a module that can be tested
 * without a browser:
 *
 * - what a click means → `tools.ts`
 * - what is under the cursor → `picking.ts`
 * - what an edit does to the city → `document.ts`
 * - whether the city is any good → `audit.ts`
 * - where things are on screen → `@deadhead/client`'s `viewport.ts`
 *
 * That split is deliberate. A canvas editor is almost impossible to test
 * through its UI, so the UI is kept as thin as it can be and the logic is put
 * somewhere a test can reach. What is left here — event listeners, a redraw
 * request, a file download — is the part where being wrong is obvious.
 */
import { screenToWorld, type ViewportState } from '@deadhead/client';
import { emptyCityJson, type CityJson } from '@deadhead/proto';

import { formatFindings, isPlayable, type Finding } from './audit.js';
import { CityDocument, CityExportError } from './document.js';
import { toleranceForZoom, type Point } from './picking.js';
import { draw } from './render.js';
import {
  cancel,
  click,
  initialToolState,
  selectTool,
  type ToolKind,
  type ToolState,
} from './tools.js';

const TOOLS: { kind: ToolKind; key: string; label: string }[] = [
  { kind: 'select', key: 'v', label: 'select' },
  { kind: 'road', key: 'r', label: 'road' },
  { kind: 'building', key: 'b', label: 'building' },
  { kind: 'spawn', key: 's', label: 'spawn' },
  { kind: 'destination', key: 'd', label: 'dest' },
  { kind: 'landmark', key: 'l', label: 'landmark' },
  { kind: 'anchor', key: 'a', label: 'demand' },
  { kind: 'erase', key: 'x', label: 'erase' },
];

const GRID = 10;

const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
const context = canvas.getContext('2d')!;
const panelStatus = document.querySelector<HTMLElement>('#status')!;
const panelFindings = document.querySelector<HTMLElement>('#findings')!;
const hintBar = document.querySelector<HTMLElement>('#hint')!;
const toolBar = document.querySelector<HTMLElement>('#tools')!;
const fileInput = document.querySelector<HTMLInputElement>('#file')!;

let doc = new CityDocument(emptyCityJson('city-01'));
let state: ToolState = initialToolState('road');
let cursor: Point | null = null;

/** Pan and zoom. Rotation stays at zero — a rotating editor is a nuisance. */
const camera = { x: 0, y: 0, zoom: 1 };
let panning: { screenX: number; screenY: number; camX: number; camY: number } | null = null;

/** Pixels per world unit at zoom 1, before the device-pixel ratio. */
const PIXELS_PER_UNIT = 2;

function view(): ViewportState {
  return {
    x: camera.x,
    y: camera.y,
    rotation: 0,
    zoom: camera.zoom,
    width: canvas.width,
    height: canvas.height,
    pixelsPerUnit: PIXELS_PER_UNIT * devicePixelRatio,
  };
}

/** A mouse event's position in world units. */
function worldOf(event: MouseEvent): Point {
  const rect = canvas.getBoundingClientRect();
  return screenToWorld(
    view(),
    (event.clientX - rect.left) * devicePixelRatio,
    (event.clientY - rect.top) * devicePixelRatio,
  );
}

function tolerance(): number {
  return toleranceForZoom(8 * devicePixelRatio, camera.zoom, PIXELS_PER_UNIT * devicePixelRatio);
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

let queued = false;

/**
 * Ask for a redraw.
 *
 * Coalesced through `requestAnimationFrame`: a drag fires far more events than
 * the display has frames, and redrawing per event is how a canvas editor
 * becomes sluggish on exactly the machine it feels fine on in testing.
 */
function invalidate(): void {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    render();
  });
}

function render(): void {
  draw(context, {
    view: view(),
    city: doc.city,
    selection: state.selection,
    pendingNode: state.pendingNode,
    pendingCorner: state.pendingCorner,
    cursor,
    grid: GRID,
  });
  renderPanel();
  hintBar.textContent = state.hint;
}

function renderPanel(): void {
  const city = doc.city;
  const findings = doc.audit();

  panelStatus.innerHTML = `
    <h2>city</h2>
    <dl>
      ${row('name', city.name)}
      ${row('junctions', city.nodes.length)}
      ${row('roads', city.edges.length)}
      ${row('buildings', city.buildings.length)}
      ${row('spawns', city.spawns.length)}
      ${row('destinations', city.destinations.length)}
      ${row('landmarks', city.landmarks.length)}
      ${row('demand', city.demandAnchors.length)}
      ${row('selected', state.selection ? `${state.selection.kind} ${state.selection.index}` : '—')}
    </dl>`;

  panelFindings.innerHTML =
    `<h2>audit — ${isPlayable(findings) ? 'playable' : 'not playable'}</h2>` +
    (findings.length === 0
      ? '<p class="clean">No problems found.</p>'
      : findings.map(findingRow).join(''));

  document.querySelector<HTMLButtonElement>('#undo')!.disabled = !doc.canUndo;
  document.querySelector<HTMLButtonElement>('#redo')!.disabled = !doc.canRedo;
}

const escape = (value: unknown): string =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const row = (key: string, value: unknown): string =>
  `<dt>${escape(key)}</dt><dd>${escape(value)}</dd>`;

const findingRow = (finding: Finding): string =>
  `<div class="finding ${finding.severity}">${escape(finding.message)}</div>`;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

function resize(): void {
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * devicePixelRatio);
  canvas.height = Math.round(rect.height * devicePixelRatio);
  invalidate();
}

canvas.addEventListener('mousedown', (event) => {
  // Middle button or space-drag pans; left button uses the tool.
  if (event.button === 1 || event.shiftKey) {
    panning = { screenX: event.clientX, screenY: event.clientY, camX: camera.x, camY: camera.y };
    event.preventDefault();
    return;
  }
  if (event.button !== 0) return;

  state = click(doc, state, worldOf(event), { tolerance: tolerance() });
  invalidate();
});

canvas.addEventListener('mousemove', (event) => {
  if (panning !== null) {
    const scale = camera.zoom * PIXELS_PER_UNIT;
    camera.x = panning.camX - (event.clientX - panning.screenX) / scale;
    camera.y = panning.camY - (event.clientY - panning.screenY) / scale;
    invalidate();
    return;
  }
  cursor = worldOf(event);
  // Only redraw while something is previewing; otherwise a mousemove is free.
  if (state.pendingNode !== null || state.pendingCorner !== null) invalidate();
});

canvas.addEventListener('mouseleave', () => {
  cursor = null;
  invalidate();
});

addEventListener('mouseup', () => {
  panning = null;
});

canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    // Zoom about the cursor, not the centre: zooming toward the middle of the
    // screen makes navigating a large city a chore.
    const before = worldOf(event);
    camera.zoom = Math.min(8, Math.max(0.05, camera.zoom * Math.exp(-event.deltaY * 0.0015)));
    const after = worldOf(event);
    camera.x += before.x - after.x;
    camera.y += before.y - after.y;
    invalidate();
  },
  { passive: false },
);

addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement) return;

  const meta = event.metaKey || event.ctrlKey;
  if (meta && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey ? doc.redo() : doc.undo()) {
      // The selection indexes into lists that just changed shape.
      state = { ...cancel(state), selection: null };
    }
    invalidate();
    return;
  }

  if (event.key === 'Escape') {
    state = cancel(state);
    invalidate();
    return;
  }

  const tool = TOOLS.find((t) => t.key === event.key.toLowerCase());
  if (tool !== undefined) {
    state = selectTool(state, tool.kind);
    syncToolButtons();
    invalidate();
  }
});

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

function buildToolButtons(): void {
  for (const tool of TOOLS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `${tool.label} (${tool.key})`;
    button.dataset.tool = tool.kind;
    button.addEventListener('click', () => {
      state = selectTool(state, tool.kind);
      syncToolButtons();
      invalidate();
    });
    toolBar.append(button);
  }
  syncToolButtons();
}

function syncToolButtons(): void {
  for (const button of toolBar.querySelectorAll<HTMLButtonElement>('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.tool === state.tool));
  }
}

document.querySelector('#undo')!.addEventListener('click', () => {
  doc.undo();
  state = { ...cancel(state), selection: null };
  invalidate();
});

document.querySelector('#redo')!.addEventListener('click', () => {
  doc.redo();
  state = { ...cancel(state), selection: null };
  invalidate();
});

/**
 * Export, refusing when the city would not load.
 *
 * `W-02`'s done-when is "loaded by the game with zero hand-editing", so the
 * button runs the same checks the game will and declines rather than writing a
 * file that fails later, somewhere with less context.
 */
document.querySelector('#save')!.addEventListener('click', () => {
  let json: CityJson;
  try {
    json = doc.export().json;
  } catch (error) {
    if (error instanceof CityExportError) {
      hintBar.textContent = `Cannot export — ${error.findings.filter((f) => f.severity === 'error').length} error(s). See the panel.`;
      console.warn(formatFindings(error.findings));
    } else {
      hintBar.textContent = String(error);
    }
    return;
  }

  const blob = new Blob([`${JSON.stringify(json, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${json.name || 'city'}.json`;
  link.click();
  URL.revokeObjectURL(url);
  hintBar.textContent = `Exported ${link.download}.`;
});

document.querySelector('#load')!.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file === undefined) return;

  void file.text().then((text) => {
    try {
      // A fresh document, so undo cannot rewind into the previous city — which
      // would produce a state that is half one file and half another.
      doc = new CityDocument(JSON.parse(text) as CityJson);
      state = { ...cancel(state), selection: null };
      hintBar.textContent = `Loaded ${file.name}.`;
    } catch (error) {
      hintBar.textContent = `Could not read ${file.name}: ${String(error)}`;
    }
    invalidate();
  });
  fileInput.value = '';
});

/**
 * The live document, for the console.
 *
 * A dev tool's escape hatch: it makes the city inspectable from devtools while
 * authoring, and it is what lets an automated check drive the real UI and then
 * verify the *actual* exported bytes rather than a reconstruction of them.
 *
 * Deliberately read-through rather than a handle to mutate. Nothing in the
 * editor reads it back, so it cannot become load-bearing by accident.
 */
Object.defineProperty(globalThis, '__cityedit', {
  get: () => ({ city: doc.city, findings: doc.audit(), tool: state.tool }),
});

addEventListener('resize', resize);
buildToolButtons();
resize();
