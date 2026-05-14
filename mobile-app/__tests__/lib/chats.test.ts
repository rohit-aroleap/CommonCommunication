import { isDailyGroup } from "@/lib/chats";
import type { ChatRow } from "@/types";

function row(partial: Partial<ChatRow>): ChatRow {
  return {
    chatKey: "k",
    chatId: "k@g.us",
    chatType: "group",
    phone: "",
    explicitName: null,
    groupName: null,
    private: false,
    lastMsgAt: 0,
    preview: "",
    direction: "in",
    sentByName: null,
    ...partial,
  };
}

describe("isDailyGroup", () => {
  it("matches groups with the Daily-Workout prefix", () => {
    expect(
      isDailyGroup(row({ groupName: "Daily Workout Ferra Cohort 7" })),
    ).toBe(true);
  });
  it("rejects groups with a different name", () => {
    expect(isDailyGroup(row({ groupName: "Aroleap HQ" }))).toBe(false);
    expect(isDailyGroup(row({ groupName: null }))).toBe(false);
  });
  it("rejects non-groups even if the explicit name matches", () => {
    expect(
      isDailyGroup(
        row({ chatType: "user", groupName: "Daily Workout Ferra C 1" }),
      ),
    ).toBe(false);
  });
});
