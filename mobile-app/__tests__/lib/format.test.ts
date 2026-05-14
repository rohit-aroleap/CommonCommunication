import { dayLabel, formatTime, prettyStatus } from "@/lib/format";

describe("formatTime", () => {
  it("returns empty for falsy", () => {
    expect(formatTime(undefined)).toBe("");
    expect(formatTime(0)).toBe("");
  });
  it("renders 'Yesterday' for yesterday", () => {
    const yest = new Date();
    yest.setDate(yest.getDate() - 1);
    expect(formatTime(yest.getTime())).toBe("Yesterday");
  });
});

describe("dayLabel", () => {
  it("renders 'Today' for today", () => {
    expect(dayLabel(Date.now())).toBe("Today");
  });
  it("renders 'Yesterday' for yesterday", () => {
    const yest = new Date();
    yest.setDate(yest.getDate() - 1);
    expect(dayLabel(yest.getTime())).toBe("Yesterday");
  });
});

describe("prettyStatus", () => {
  it("title-cases lower-snake and ALL_CAPS_SNAKE forms", () => {
    expect(prettyStatus("ACTIVE")).toBe("Active");
    expect(prettyStatus("ORDER_PENDING")).toBe("Order pending");
  });
});
