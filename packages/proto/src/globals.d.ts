/**
 * Universal globals that TypeScript's ES2022 lib does not declare.
 *
 * `@deadhead/proto` omits `"DOM"` from its `lib` on purpose — it is shared by
 * the browser, a Durable Object and a replay-validating Worker, and must not
 * assume any of them. `TextEncoder`/`TextDecoder` are not DOM: they are WHATWG
 * Encoding globals present in all three, and UTF-8 is fully specified, so they
 * are deterministic. Declaring them here is narrower than widening `lib`.
 */
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare class TextDecoder {
  constructor(label?: string);
  decode(input?: ArrayBufferView | ArrayBuffer): string;
}
