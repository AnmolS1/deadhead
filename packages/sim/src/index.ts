/**
 * `@deadhead/sim` — the deterministic simulation core.
 *
 * This package runs byte-identically in three places: the browser (prediction),
 * a Durable Object (authority), and a Worker (replay validation). It is pure
 * ESM with zero third-party dependencies and no ambient globals.
 *
 * What that forbids, in short — no DOM, no wall-clock time, no unseeded
 * randomness, and none of the `Math` members the ECMAScript spec permits an
 * engine to approximate (use the fixed-point equivalents in `fx.ts`). No
 * floating point survives into state. CLAUDE.md hard invariant #1 is the full
 * list; `npm run lint:sim-purity` (`S-02`) enforces it, and the `tsconfig` here
 * omits `"DOM"` from `lib` so the browser globals do not typecheck at all.
 *
 * The only entry point is {@link step}.
 */

export { step } from './step.js';

export type { Inputs, PackedInput, PlayerId } from './types.js';

export {
  FX_MAGNITUDE_LIMIT,
  FX_MAX_SQUARABLE,
  SIM_VERSION,
  TICK_HZ,
  TICK_INTERVAL_US,
  WORLD_HALF_EXTENT,
  WORLD_MAX,
  WORLD_MIN,
} from './constants.js';

export {
  FX_HALF,
  FX_ONE,
  FX_SHIFT,
  QUARTER_TURN,
  TURN,
  fxAbs,
  fxAtan2,
  fxClamp,
  fxCos,
  fxDiv,
  fxFloorToInt,
  fxFromInt,
  fxFromRatio,
  fxMul,
  fxRoundToInt,
  fxSin,
  fxSqrt,
} from './fx.js';

export {
  RNG_LANES,
  rngCreate,
  rngIsDegenerate,
  rngNextBelow,
  rngNextRange,
  rngNextU32,
  rngPick,
  rngPickIndex,
  rngSeed,
} from './rng.js';

export type { RngState } from './rng.js';

export {
  Car,
  CarFlags,
  Header,
  MAX_PASSENGERS,
  MAX_PLAYERS,
  MAX_TRAFFIC,
  NO_CARRIER,
  NO_PASSENGER,
  PassengerFlags,
  Passenger,
  Traffic,
  WORLD_BYTES,
  WORLD_INT32S,
  WorldFlags,
  cloneWorld,
  createWorld,
  deserialize,
  getCar,
  getCityHash,
  getFormatVersion,
  getPassenger,
  getPlayerCount,
  getSeed,
  getTick,
  getTraffic,
  hashWorld,
  isRunning,
  rngOf,
  serialize,
  setCar,
  setPassenger,
  setTraffic,
} from './world.js';

export type { World } from './world.js';

export { CarTuning, carSpeed, carSpeedFraction, carVelocityAngle } from './car.js';

export { ClockTuning, beginFare, endFare, grantDeadhead, isCarrying, isDriving } from './clock.js';

export {
  boxesFromUnits,
  buildStaticGeometry,
  emptyGeometry,
  overlapsStatic,
  sweepCar,
} from './collide.js';

export type { CollisionResult, StaticGeometry } from './collide.js';

export { emptyCity, prepareCity } from './city.js';

export type { RuntimeCity } from './city.js';

export {
  PassengerTuning,
  demandAt,
  despawnPassenger,
  isPassengerActive,
  isRush,
  passengerCount,
} from './passengers.js';

export { FareTuning, cashOf, fareValue, waitingCount, withinRadius } from './fare.js';
