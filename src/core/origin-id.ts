// Origin-id codec: a structured 32-hex trace/correlation id that says which surface
// and environment started a chain.
//
// Frontends mint one of these and send it as the `x-b3-traceid` header on a Hasura
// mutation. With Hasura's OpenTelemetry config on, that id lands in the event
// payload's `event.trace_context.trace_id`, which `normalizeHasuraEvent`
// (src/plugins/hasura-shared/adapter.ts) already adopts as the invocation's
// correlationId. Because the whole write -> event -> write chain shares that one id
// (loopGuard chains it), decoding the final correlation id tells the console and
// observability which app or service kicked off the chain, and in which env, even when
// no other origin context arrived.
//
// This is a pure, dependency-free, isomorphic core primitive (like tracking-token.ts):
// it runs in a browser (the minting frontend) and in node (the decoding plugin). The
// only ambient it touches is `globalThis.crypto.getRandomValues` for the random bits.
// No Math.random, no Date.
//
// Bit layout, most significant nibble first (32 hex chars = 128 bits), every field
// nibble-aligned:
//
//   hex 0-5   (bits 0-23)    magic     constant 0xc0ffee — marks the id as structured
//   hex 6     (bits 24-27)   version   this spec is version 1
//   hex 7-8   (bits 28-35)   originId  0-255, opaque surface number (names are consumer config)
//   hex 9-10  (bits 36-43)   flags     bits 0-2 = env; bits 3-7 reserved (written zero)
//   hex 11-31 (bits 44-127)  random    84 random bits
//
// env values (the low 3 bits of the flags byte):
//   0 unknown, 1 prod, 2 test, 3 preview, 4 local, 5-7 reserved.
//
// Deliberately NOT packed: a timestamp (the server's event time is already on the
// payload and the rows) and user identity (that arrives signed via session_variables).
// The id is display-only and spoofable — treat a decode as a hint about origin, never
// as proof of it. The codec knows numbers, not names: mapping an originId number to a
// display name is the consumer's config (see the origin-decoder plugin's `originNames`).

/** The 24-bit magic prefix (hex `c0ffee`) that marks a 32-hex id as a structured origin id. */
export const ORIGIN_ID_MAGIC = 0xc0ffee;

/** The version this codec writes and the only version `decodeOriginId` accepts. */
export const ORIGIN_ID_VERSION = 1;

/** Lowercase hex form of the magic, used as the id's first 6 characters. */
const MAGIC_HEX = ORIGIN_ID_MAGIC.toString(16).padStart(6, '0');

/** Exactly 32 lowercase hex chars. Uppercase is rejected on purpose (B3 ids are lowercase). */
const HEX_32_RE = /^[0-9a-f]{32}$/;

/** env number -> display name. Anything not listed (0, and the reserved 5-7) reads as 'unknown'. */
const ENV_NAMES: Record<number, string> = {
  0: 'unknown',
  1: 'prod',
  2: 'test',
  3: 'preview',
  4: 'local',
};

/** Inputs to {@link encodeOriginId}. */
export interface EncodeOriginIdInput {
  /** Opaque surface number, 0-255. Which app or service is minting the id. */
  originId: number;
  /** Env number, 0-7 (0 unknown, 1 prod, 2 test, 3 preview, 4 local, 5-7 reserved). */
  env: number;
}

/** The decoded fields of a structured origin id. */
export interface DecodedOriginId {
  /** Always 1 for now; a decode of any other version returns null instead. */
  version: number;
  /** The opaque surface number, 0-255. */
  originId: number;
  /** The env number carried in the low 3 bits of the flags byte, 0-7. */
  env: number;
  /** Display name for a known env value, else 'unknown'. */
  envName: string;
  /** The raw flags byte, 0-255. Exposed whole so callers can read reserved bits later. */
  flags: number;
}

/** Fill `count` random bytes from the platform CSPRNG (browser or node). */
function randomBytes(count: number): Uint8Array {
  const out = new Uint8Array(count);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/**
 * Build a structured origin id: a 32-char lowercase hex string carrying the version,
 * the minting surface number, the env, and 84 random bits. Throws on an out-of-range
 * `originId` (must be an integer 0-255) or `env` (must be an integer 0-7).
 */
export function encodeOriginId({ originId, env }: EncodeOriginIdInput): string {
  if (!Number.isInteger(originId) || originId < 0 || originId > 255) {
    throw new Error(`encodeOriginId: originId must be an integer 0-255, got ${originId}`);
  }
  if (!Number.isInteger(env) || env < 0 || env > 7) {
    throw new Error(`encodeOriginId: env must be an integer 0-7, got ${env}`);
  }

  const version = ORIGIN_ID_VERSION.toString(16); // one nibble, 0-15
  const origin = originId.toString(16).padStart(2, '0');
  // Reserved bits (3-7) stay zero, so the flags byte is just the env in its low 3 bits.
  const flags = (env & 0x07).toString(16).padStart(2, '0');

  // 84 random bits = 21 hex chars. 11 bytes give 22 hex chars; drop the last nibble.
  let random = '';
  for (const b of randomBytes(11)) random += b.toString(16).padStart(2, '0');
  random = random.slice(0, 21);

  return `${MAGIC_HEX}${version}${origin}${flags}${random}`;
}

/**
 * Cheap structural check: is `id` a 32-char lowercase hex string that starts with the
 * magic? Does NOT validate the version (a future version still starts with the magic),
 * so a true result means "looks like a structured origin id", not "this codec can
 * decode it". Use {@link decodeOriginId} when you need the fields.
 */
export function isOriginId(id: string): boolean {
  return id.length === 32 && id.startsWith(MAGIC_HEX) && HEX_32_RE.test(id);
}

/**
 * Decode a structured origin id into its fields, or return null when the id is not one
 * this codec understands: not a 32-char lowercase hex string, the magic doesn't match,
 * or the version is unknown (anything other than 1). Callers treat null as "opaque id,
 * no origin info". Reserved flag bits set to nonzero are NOT rejected (forward compat):
 * the raw flags byte is returned as-is.
 */
export function decodeOriginId(id: string): DecodedOriginId | null {
  if (typeof id !== 'string' || !HEX_32_RE.test(id)) return null;
  if (id.slice(0, 6) !== MAGIC_HEX) return null;

  const version = parseInt(id.slice(6, 7), 16);
  if (version !== ORIGIN_ID_VERSION) return null;

  const originId = parseInt(id.slice(7, 9), 16);
  const flags = parseInt(id.slice(9, 11), 16);
  const env = flags & 0x07;
  const envName = ENV_NAMES[env] ?? 'unknown';

  return { version, originId, env, envName, flags };
}
