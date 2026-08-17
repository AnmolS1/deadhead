/**
 * `city.ts` — the city, prepared for the sim.
 *
 * `@deadhead/proto` owns the *format* (`W-01`); this owns what the sim needs
 * done to it once, at load, rather than every tick: building the collision
 * index from the packed building list.
 *
 * A {@link RuntimeCity} is an **input**, not state. It never changes during a
 * run, so it is shared by reference across every `step()` copy and is
 * deliberately not serialised and not hashed — see ADR 0004. Its content hash
 * *is* folded into the run seed (ADR 0005), which is what makes editing the
 * city invalidate old runs rather than silently rescore them.
 */
import { type PackedCity, packCity, emptyCityJson, validateCity } from '@deadhead/proto';

import { buildStaticGeometry, type StaticGeometry } from './collide.js';

/** A packed city plus everything derived from it that the sim needs. */
export interface RuntimeCity {
  /** The format-level city, as loaded. */
  readonly packed: PackedCity;
  /** Collision index over {@link PackedCity.buildings}, built once at load. */
  readonly statics: StaticGeometry;
}

/**
 * Prepare a packed city for play.
 *
 * Validates first: a city that fails structural validation should never reach
 * the sim, and the replay validator loads untrusted cities by id.
 */
export function prepareCity(packed: PackedCity): RuntimeCity {
  validateCity(packed);
  return { packed, statics: buildStaticGeometry(packed.buildings) };
}

/** A valid city with nothing in it. Useful for tests and for a run with no city loaded. */
export function emptyCity(): RuntimeCity {
  return prepareCity(packCity(emptyCityJson('empty')));
}
