import {
  buildFerraIndex,
  getFerraDisplayName,
  normalizeFerraPhone,
} from "@/lib/ferra";

describe("normalizeFerraPhone", () => {
  it("strips non-digits and leading zeros", () => {
    expect(normalizeFerraPhone("+91 98765-43210")).toBe("919876543210");
    expect(normalizeFerraPhone("0091-9876543210")).toBe("919876543210");
  });
  it("prepends 91 to 10-digit Indian numbers", () => {
    expect(normalizeFerraPhone("9876543210")).toBe("919876543210");
  });
  it("leaves already-91 numbers alone", () => {
    expect(normalizeFerraPhone("919876543210")).toBe("919876543210");
  });
  it("returns empty string for empty input", () => {
    expect(normalizeFerraPhone("")).toBe("");
    expect(normalizeFerraPhone(null)).toBe("");
    expect(normalizeFerraPhone(undefined)).toBe("");
  });
});

describe("buildFerraIndex", () => {
  it("indexes active and cancelled users by normalized phone", () => {
    const habit = {
      u1: { uid: "u1", phone: "919876543210", subscriptionStatus: "ACTIVE" },
      u2: { userId: "u2", phone: "0091-9876543211", subscriptionStatus: "paused" },
    };
    const cancelled = {
      u3: { phone: "9876543212", subscriptionStatus: "cancelled" },
    };
    const idx = buildFerraIndex(habit as any, cancelled as any);
    expect(idx.phoneToUid["919876543210"]).toBe("u1");
    expect(idx.phoneToUid["919876543211"]).toBe("u2");
    // Cancelled users don't claim phoneToUid (only active users do).
    expect(idx.phoneToUid["919876543212"]).toBeUndefined();
    expect(idx.cancelledPhones.has("919876543212")).toBe(true);
    expect(idx.phoneToStatus["919876543210"]).toBe("ACTIVE");
    expect(idx.phoneToStatus["919876543211"]).toBe("PAUSED");
    expect(idx.phoneToStatus["919876543212"]).toBe("CANCELLED");
  });
  it("handles array-shaped lists too", () => {
    const arr = [
      { uid: "u1", phone: "919876543210", subscriptionStatus: "ACTIVE" },
    ];
    const idx = buildFerraIndex(arr as any, null);
    expect(idx.phoneToUid["919876543210"]).toBe("u1");
  });
});

describe("getFerraDisplayName", () => {
  const habit = {
    u1: { uid: "u1", phone: "919876543210", name: "Alice" },
  };
  const cancelled = {
    u3: { phone: "9876543212", name: "Bob" },
  };
  const idx = buildFerraIndex(habit as any, cancelled as any);

  it("returns the active user's name", () => {
    expect(
      getFerraDisplayName("9876543210", habit as any, cancelled as any, idx),
    ).toBe("Alice");
  });
  it("falls back to cancelled user", () => {
    expect(
      getFerraDisplayName("9876543212", habit as any, cancelled as any, idx),
    ).toBe("Bob");
  });
  it("returns null when no match", () => {
    expect(
      getFerraDisplayName("9999999999", habit as any, cancelled as any, idx),
    ).toBeNull();
  });
});
