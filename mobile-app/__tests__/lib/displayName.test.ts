import { avatarInitial, resolveDisplayName } from "@/lib/displayName";
import { buildFerraIndex } from "@/lib/ferra";

const habit = {
  u1: { uid: "u1", phone: "919876543210", name: "Alice" },
};
const ferraIndex = buildFerraIndex(habit as any, null);
const baseDeps = {
  habitUsers: habit as any,
  cancelledUsers: null,
  ferraIndex,
  contacts: {} as any,
};

describe("resolveDisplayName", () => {
  it("returns groupName for groups (no Ferra lookup)", () => {
    const out = resolveDisplayName(
      "ignored",
      "ignored",
      { chatType: "group", groupName: "Aroleap HQ" },
      baseDeps,
    );
    expect(out).toBe("Aroleap HQ");
  });
  it("falls back to 'Unnamed group' for groups with no name", () => {
    const out = resolveDisplayName(
      "ignored",
      null,
      { chatType: "group" },
      baseDeps,
    );
    expect(out).toBe("Unnamed group");
  });
  it("prefers Ferra-known name over phone", () => {
    const out = resolveDisplayName(
      "9876543210",
      null,
      { chatType: "user" },
      baseDeps,
    );
    expect(out).toBe("Alice");
  });
  it("wraps a manual override in parens unless it matches Ferra", () => {
    expect(
      resolveDisplayName(
        "9876543210",
        "Alice Smith",
        { chatType: "user" },
        baseDeps,
      ),
    ).toBe("(Alice Smith)");
    // Case-insensitive match against Ferra → unwrapped.
    expect(
      resolveDisplayName(
        "9876543210",
        "alice",
        { chatType: "user" },
        baseDeps,
      ),
    ).toBe("Alice");
  });
  it("falls back to commonComm/contacts/<phone>/name", () => {
    const deps = {
      ...baseDeps,
      contacts: { "919876543299": { name: "From group" } } as any,
    };
    expect(
      resolveDisplayName(
        "919876543299",
        null,
        { chatType: "user" },
        deps,
      ),
    ).toBe("From group");
  });
  it("falls back to the phone when nothing is known", () => {
    expect(
      resolveDisplayName(
        "919999999999",
        null,
        { chatType: "user" },
        baseDeps,
      ),
    ).toBe("919999999999");
  });
});

describe("avatarInitial", () => {
  it("uses first letter of the trimmed name", () => {
    expect(avatarInitial("Alice")).toBe("A");
    expect(avatarInitial("  rohit")).toBe("R");
  });
  it("strips parens before picking the initial", () => {
    expect(avatarInitial("(Alice Smith)")).toBe("A");
  });
  it("falls back to '?' for empty / missing", () => {
    expect(avatarInitial("")).toBe("?");
    expect(avatarInitial(null as any)).toBe("?");
  });
});
