/**
 * Node globals the city generator needs.
 *
 * The same trade `tools/simrun` makes: declaring the handful of things this one
 * script uses is narrower than pulling in `@types/node`, and keeps the
 * dependency count where it is. Nothing else in `@deadhead/cityedit` touches
 * these — the editor itself is a browser bundle.
 */
declare const process: {
  readonly argv: readonly string[];
  exit(code: number): never;
};

declare module 'node:fs' {
  export function writeFileSync(path: string, data: string | Uint8Array): void;
  export function mkdirSync(path: string, options: { recursive: boolean }): void;
}

declare module 'node:path' {
  export function resolve(...parts: readonly string[]): string;
  export function dirname(path: string): string;
}
