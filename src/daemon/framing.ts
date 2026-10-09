/**
 * Length-prefixed JSON framing for the local IPC channel.
 *
 * A 4-byte big-endian length prefix removes any ambiguity from newlines inside
 * payloads and lets us reject oversized messages before allocating for them.
 */

export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

export function encodeMessage(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length > MAX_MESSAGE_BYTES) {
    throw new Error(
      `IPC message of ${payload.length} bytes exceeds the ${MAX_MESSAGE_BYTES} byte limit.`,
    );
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

export interface DecoderCallbacks {
  onMessage(value: unknown): void;
  onError(error: Error): void;
}

export function createMessageDecoder(callbacks: DecoderCallbacks): (chunk: Buffer) => void {
  let buffer: Buffer = Buffer.alloc(0);
  let failed = false;

  return (chunk: Buffer): void => {
    if (failed) return;
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);

    for (;;) {
      if (buffer.length < 4) return;
      const length = buffer.readUInt32BE(0);
      if (length > MAX_MESSAGE_BYTES) {
        failed = true;
        callbacks.onError(
          new Error(
            `IPC message declares ${length} bytes, above the ${MAX_MESSAGE_BYTES} byte limit.`,
          ),
        );
        return;
      }
      if (buffer.length < 4 + length) return;
      const payload = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      try {
        callbacks.onMessage(JSON.parse(payload.toString("utf8")));
      } catch (error) {
        failed = true;
        // Wrap unconditionally: the engine's own JSON wording changes between
        // Node versions, and callers need a stable, self-describing prefix.
        callbacks.onError(
          new Error(
            `Malformed IPC payload: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return;
      }
    }
  };
}
