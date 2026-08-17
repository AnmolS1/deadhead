/**
 * @deadhead/client — canvas renderer, input, audio and UI.
 *
 * Scaffold only (D-01). The fixed-timestep app shell arrives in C-01.
 *
 * This package reads sim state and never mutates it. Floats are allowed here
 * and nowhere upstream.
 */
import { SIM_VERSION } from '@deadhead/sim';

export const CLIENT_VERSION = 0;

export { SIM_VERSION };
