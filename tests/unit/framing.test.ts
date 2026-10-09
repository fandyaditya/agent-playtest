import { describe, expect, it } from "vitest";
import {
  createMessageDecoder,
  encodeMessage,
  MAX_MESSAGE_BYTES,
} from "../../src/daemon/framing.ts";

describe("IPC framing", () => {
  it("round-trips a value through encode/decode", () => {
    const received: unknown[] = [];
    const decode = createMessageDecoder({
      onMessage: (value) => received.push(value),
      onError: (error) => {
        throw error;
      },
    });

    decode(encodeMessage({ command: "snapshot", params: { depth: 3 } }));

    expect(received).toEqual([{ command: "snapshot", params: { depth: 3 } }]);
  });

  it("reassembles messages split across chunks", () => {
    const received: unknown[] = [];
    const decode = createMessageDecoder({
      onMessage: (value) => received.push(value),
      onError: (error) => {
        throw error;
      },
    });

    const frame = encodeMessage({ hello: "world", nested: { list: [1, 2, 3] } });
    for (const byte of frame) decode(Buffer.from([byte]));

    expect(received).toHaveLength(1);
  });

  it("decodes several messages arriving in one chunk", () => {
    const received: unknown[] = [];
    const decode = createMessageDecoder({
      onMessage: (value) => received.push(value),
      onError: (error) => {
        throw error;
      },
    });

    decode(Buffer.concat([encodeMessage({ n: 1 }), encodeMessage({ n: 2 })]));
    expect(received).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("rejects an oversized payload before allocating it", () => {
    const errors: Error[] = [];
    const decode = createMessageDecoder({
      onMessage: () => undefined,
      onError: (error) => errors.push(error),
    });

    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_MESSAGE_BYTES + 1, 0);
    decode(header);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("above the");
  });

  it("reports malformed JSON instead of throwing out of the stream", () => {
    const errors: Error[] = [];
    const decode = createMessageDecoder({
      onMessage: () => undefined,
      onError: (error) => errors.push(error),
    });

    const payload = Buffer.from("{not json", "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    decode(Buffer.concat([header, payload]));

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("Malformed IPC payload");
    // The engine's JSON wording differs between Node versions; only the JSON-ness is stable.
    expect(errors[0]?.message).toMatch(/JSON/);
  });

  it("refuses to encode a message above the limit", () => {
    expect(() => encodeMessage({ big: "x".repeat(MAX_MESSAGE_BYTES + 1) })).toThrow(/exceeds the/);
  });
});
