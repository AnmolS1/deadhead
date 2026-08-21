/**
 * `generate.ts` — write City 01 out, and refuse to write a broken one.
 *
 * The audit runs before the file is written, so a city with errors never
 * reaches `packages/client/assets/`. That is deliberate: a bad city on disk is
 * one that gets loaded, played and puzzled over, when the failure was known at
 * the moment it was generated.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { packCity, validateCity } from '@deadhead/proto';
import { prepareCity } from '@deadhead/sim';

import { audit, formatFindings, isPlayable } from '../audit.js';
import { assertCutIntact, buildCity01 } from './city-01.js';

const OUT = resolve(process.argv[2] ?? 'packages/client/assets/cities/01.json');

const city = buildCity01();
const findings = audit(city);

console.log(formatFindings(findings));
console.log('');
console.log(
  `${city.nodes.length} junctions, ${city.edges.length} roads, ${city.buildings.length} blocks, ` +
    `${city.spawns.length} spawns, ${city.destinations.length} destinations, ` +
    `${city.landmarks.length} landmarks, ${city.demandAnchors.length} demand anchors`,
);

// City 01's own design invariant, which no general rule can know about.
const cut = assertCutIntact(city);
for (const problem of cut) console.error(`design: ${problem}`);
if (cut.length > 0) {
  console.error('\nThe Cut has been breached — the city no longer routes around anything.');
  process.exit(1);
}

if (!isPlayable(findings)) {
  console.error('\nRefusing to write a city with errors.');
  process.exit(1);
}

// The same two checks the game runs, so "it generated" and "it loads" cannot
// drift apart.
const packed = packCity(city);
validateCity(packed);
prepareCity(packed);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(city, null, 2)}\n`);
console.log(`\nwrote ${OUT} — ${packed.bytes.length} packed bytes, hash ${packed.contentHash}`);
