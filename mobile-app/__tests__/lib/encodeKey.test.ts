import { chatKeyToChatId, encodeKey } from "@/lib/encodeKey";

describe("encodeKey", () => {
  it("escapes Firebase-forbidden characters", () => {
    expect(encodeKey("919876543210@c.us")).toBe("919876543210@c_us");
    expect(encodeKey("foo.bar#baz")).toBe("foo_bar_baz");
    expect(encodeKey("a/b/c")).toBe("a_b_c");
    expect(encodeKey("with$bracket[and]")).toBe("with_bracket_and_");
  });
  it("handles null / undefined", () => {
    expect(encodeKey(null as any)).toBe("");
    expect(encodeKey(undefined as any)).toBe("");
  });
});

describe("chatKeyToChatId", () => {
  it("restores @c.us / @g.us suffixes", () => {
    expect(chatKeyToChatId("919876543210@c_us")).toBe("919876543210@c.us");
    expect(chatKeyToChatId("12345@g_us")).toBe("12345@g.us");
  });
  it("leaves non-suffixed keys alone", () => {
    expect(chatKeyToChatId("plain_thing")).toBe("plain_thing");
  });
  it("only matches at the end", () => {
    // @c_us in the middle of a key should NOT get rewritten — that would
    // corrupt a key. Only the suffix gets restored.
    expect(chatKeyToChatId("foo@c_usbar")).toBe("foo@c_usbar");
  });
});
