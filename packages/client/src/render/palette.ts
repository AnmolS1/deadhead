/**
 * `render/palette.ts` — the whole colour vocabulary, in one place.
 *
 * `W-05` implements ADR 0001: **a city creased out of a single sheet of paper**,
 * flat-shaded, high contrast, **monochrome plus one accent**.
 *
 * ## These are ponderance's tokens, not new colours
 *
 * The site already names this aesthetic — `--color-crease`, `--color-crane`,
 * `--color-graph` — and ADR 0001 chose the folded city partly *because* the
 * house language was already folding. Inventing a parallel palette here would
 * throw that away and leave the game looking like something bolted onto the
 * site. Every value below is copied from `ponderance/src/styles/global.css`,
 * and the comment on each says which token it is, so a drift is visible rather
 * than silent.
 *
 * Canvas cannot read CSS custom properties, so they are duplicated as literals.
 * That duplication is the cost of the canvas; naming the source is the mitigation.
 *
 * ## The accent rule, which is load-bearing
 *
 * ADR 0001 reserves the accent for **motion and the empty-cab state**, and that
 * is the answer to the risk it also names: folded paper reads gentle, and this
 * game is not gentle. A city rendered entirely in paper and ink, where the one
 * saturated thing on screen is your own cab burning its deadhead clock, is not
 * gentle — the colour *is* the alarm.
 *
 * So {@link Ink.crane} is spent on exactly three things: an empty cab, the
 * particles thrown off by motion, and nothing else. Every other distinction —
 * Meter against Rush, one district against another — is made with **form and
 * value**, never by adding a hue. If a fourth use for the accent appears,
 * something else has to give it up.
 */

/**
 * The palette.
 *
 * Two families: paper (light, the sheet) and graphite (dark, ink and the
 * shadow a fold casts). `crease` is the structural blue between them. `crane`
 * is the only saturated colour in the game.
 */
export const Ink = {
  /** `--color-graph` — the sheet itself. Everything is cut from this. */
  paper: '#EEF0EC',
  /** `--color-graph-card` — a fold face turned toward the light. */
  paperLit: '#F6F7F4',
  /** `--color-inset` — the brightest fold, used sparingly for a hard highlight. */
  paperHighlight: '#FFFFFF',

  /** `--color-graphite` — ink, and the underside of a fold. */
  graphite: '#1B2A33',
  /** `--color-graphite-60` — softened ink, for figures at distance. */
  graphiteSoft: 'rgba(27, 42, 51, 0.72)',
  /** `--color-graphite-40` — the shadow a raised flap drops on the sheet. */
  graphiteShadow: 'rgba(27, 42, 51, 0.4)',

  /** `--color-crease` — the fold line. Streets are creases in the sheet. */
  crease: '#2E5E8C',
  /** `--color-crease-line` — a crease seen at a shallow angle. */
  creaseFaint: 'rgba(46, 94, 140, 0.13)',
  /** `--color-crease-line-bold` — a crease the sheet actually bends along. */
  creaseBold: 'rgba(46, 94, 140, 0.28)',
  /** `--color-grid-line` — the blueprint ruling underneath everything. */
  grid: 'rgba(46, 94, 140, 0.07)',

  /**
   * `--color-crane` — **the accent.** Motion, and the empty cab.
   *
   * Not a fourth thing. See the note at the top of this file.
   */
  crane: '#E84A27',
  /** `--color-crane-dark` — the accent in shadow, for the cab's underside. */
  craneDark: '#C23A1C',

  // --- baked tones ---------------------------------------------------------
  //
  // Each of these is a ponderance token composited over another one, resolved
  // to a solid. **They are solids on purpose.** Roads cross, and shadows fall
  // near each other; drawn with alpha, every junction comes out a shade darker
  // than the two streets that meet there, because the fills stack. A crossroads
  // that is a different colour from its own roads is the kind of wrong nobody
  // can name but everybody sees.
  //
  // The derivation is in the name, so a change to the source token is a visible
  // inconsistency rather than a silent one.

  /** `crease` at 10% over `paper` — the sheet pressed down. A street. */
  roadSurface: '#DBE1E2',
  /** `crease` at 16% over `paperLit` — a fold face turned away from the light. */
  foldShade: '#D6DFE3',
  /**
   * `crease` at 30% over `paper` — what a raised flap drops on the sheet.
   *
   * Cool rather than neutral grey. A neutral drop shadow is what a UI does to
   * suggest elevation; a real shadow on white paper picks up the ambient and
   * goes blue, which is also what keeps this reading as paper rather than as a
   * card floating above a background.
   */
  foldShadow: '#B4C4CF',
} as const;

/**
 * Where the light comes from, as a unit vector in world space.
 *
 * **One light, for the whole city, forever.** Every fold shadow in the game is
 * cast from this direction, which is what makes a screen full of separate
 * buildings read as one sheet of paper lifted into relief rather than as boxes
 * scattered on a background. A per-object light, or a light that follows the
 * camera, destroys that in a way that is hard to name and impossible to miss.
 *
 * Pointing down and right because the sheet reads as lit from the upper left,
 * which is where paper is lit in essentially every photograph of paper.
 */
export const LIGHT = { x: 0.55, y: 0.835 } as const;

/**
 * How far a raised fold drops its shadow, in world units.
 *
 * A constant, not a per-building height. Every flap is the same sheet lifted by
 * the same amount, so they cast the same shadow — the moment they differ, the
 * city stops being one sheet and becomes a collection of objects standing on
 * something.
 */
export const FOLD_DEPTH = 3.2;

/** Cab body, in world units. Matches `CarTuning.halfLength` / `halfWidth`. */
export const CAB = {
  halfLength: 1.1,
  halfWidth: 0.5,
} as const;
