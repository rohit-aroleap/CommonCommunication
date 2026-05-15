import { dedupMessages } from "@/lib/messageDedup";
import type { Message } from "@/types";

function msg(partial: Partial<Message>): Message {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    direction: partial.direction ?? "out",
    ts: partial.ts ?? 0,
    ...partial,
  } as Message;
}

describe("dedupMessages", () => {
  it("collapses /send + webhook copies sharing the inner unique id", () => {
    const out = dedupMessages([
      msg({
        id: "a",
        ts: 100,
        periskopeUniqueId: "ABC123",
        sentByName: "Rohit",
        text: "hi",
      }),
      msg({
        id: "b",
        ts: 110,
        periskopeMsgId: "true_919876543210@c.us_ABC123",
        text: "hi",
      }),
    ]);
    expect(out).toHaveLength(1);
    // The copy with sentByName wins so the bubble keeps "— Rohit".
    expect(out[0].sentByName).toBe("Rohit");
  });
  it("keeps messages without an inner id untouched", () => {
    const out = dedupMessages([
      msg({ id: "a", ts: 200, text: "first" }),
      msg({ id: "b", ts: 100, text: "older" }),
    ]);
    expect(out).toHaveLength(2);
    // Output is sorted by ts ascending.
    expect(out.map((m) => m.text)).toEqual(["older", "first"]);
  });
  it("doesn't lose the with-name copy even when it arrives second", () => {
    const out = dedupMessages([
      msg({ id: "a", periskopeUniqueId: "X", ts: 1 }),
      msg({ id: "b", periskopeUniqueId: "X", ts: 2, sentByName: "Rohit" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].sentByName).toBe("Rohit");
  });
});
