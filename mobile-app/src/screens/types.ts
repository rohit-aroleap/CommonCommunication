// Navigator param lists. Kept separate from the screen files so screens can
// import their own props type without circular deps.

export type RootStackParamList = {
  Tabs: undefined;
  Chats: undefined;
  Tickets: undefined;
  Team: undefined;
  // Thread route carries either a customer chatKey OR an internal DM key
  // ("dm:" + pairKey). ThreadScreen branches on the prefix to pick the
  // right Firebase path and rendering mode.
  Thread: { chatKey: string; initialTitle?: string };
  CustomerInfo: { chatKey: string };
  Settings: undefined;
};
