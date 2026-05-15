import {
  SEND_SUGGEST_MIN_COUNT,
  SEND_SUGGEST_WINDOW_MS,
  isRecentSendActivity,
  nextSendActivity,
  shouldSuggestPin,
} from "@/lib/favorites";

describe("shouldSuggestPin", () => {
  const now = 1_700_000_000_000;
  it("suggests when send count meets threshold and is within window", () => {
    expect(
      shouldSuggestPin(
        "k",
        {},
        { k: { count: SEND_SUGGEST_MIN_COUNT, lastAt: now } },
        now,
      ),
    ).toBe(true);
  });
  it("does not suggest when already a favorite", () => {
    expect(
      shouldSuggestPin(
        "k",
        { k: true },
        { k: { count: 10, lastAt: now } },
        now,
      ),
    ).toBe(false);
  });
  it("does not suggest when send count is below threshold", () => {
    expect(
      shouldSuggestPin(
        "k",
        {},
        { k: { count: SEND_SUGGEST_MIN_COUNT - 1, lastAt: now } },
        now,
      ),
    ).toBe(false);
  });
  it("does not suggest when last activity is outside the window", () => {
    expect(
      shouldSuggestPin(
        "k",
        {},
        {
          k: {
            count: SEND_SUGGEST_MIN_COUNT,
            lastAt: now - SEND_SUGGEST_WINDOW_MS - 1,
          },
        },
        now,
      ),
    ).toBe(false);
  });
  it("returns false for unknown chats", () => {
    expect(shouldSuggestPin("missing", {}, {}, now)).toBe(false);
  });
});

describe("nextSendActivity", () => {
  const now = 1_700_000_000_000;
  it("starts a fresh counter when there's no previous activity", () => {
    expect(nextSendActivity(null, now)).toEqual({ count: 1, lastAt: now });
  });
  it("increments the counter when within the window", () => {
    expect(
      nextSendActivity({ count: 4, lastAt: now - 1000 }, now),
    ).toEqual({ count: 5, lastAt: now });
  });
  it("resets the counter when the previous activity is stale", () => {
    expect(
      nextSendActivity(
        { count: 12, lastAt: now - SEND_SUGGEST_WINDOW_MS - 1 },
        now,
      ),
    ).toEqual({ count: 1, lastAt: now });
  });
});

describe("isRecentSendActivity", () => {
  const now = 1_700_000_000_000;
  it("returns false for missing activity", () => {
    expect(isRecentSendActivity(undefined, now)).toBe(false);
  });
  it("returns true for activity inside the window", () => {
    expect(
      isRecentSendActivity({ count: 1, lastAt: now - 1000 }, now),
    ).toBe(true);
  });
  it("returns false for activity outside the window", () => {
    expect(
      isRecentSendActivity(
        { count: 1, lastAt: now - SEND_SUGGEST_WINDOW_MS - 1 },
        now,
      ),
    ).toBe(false);
  });
});
