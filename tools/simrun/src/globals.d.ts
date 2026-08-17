/**
 * Node globals this CLI needs.
 *
 * `tools/simrun` runs only under Node — it reads files from disk, which the sim
 * itself may never do. Declaring the handful of globals used here is narrower
 * than pulling in `@types/node`, and keeps the dependency count at zero.
 */
declare const process: {
  readonly argv: readonly string[];
  exitCode: number | undefined;
  readonly stdout: { write(text: string): void };
  readonly stderr: { write(text: string): void };
};

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function readFileSync(path: string): Uint8Array;
  export function writeFileSync(path: string, data: string | Uint8Array): void;
}

declare module 'node:path' {
  export function resolve(...parts: readonly string[]): string;
  export function dirname(path: string): string;
}
