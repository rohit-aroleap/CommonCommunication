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
  // v1.206: anchorMsgKey lets callers (TicketsScreen, future deep-links)
  // request the thread scrolls to a specific message on open instead of
  // landing on the latest. ThreadScreen reads it from route.params,
  // finds the message in the list once it's loaded, and scrollToIndex's
  // to it with a brief highlight.
  Thread: { chatKey: string; initialTitle?: string; anchorMsgKey?: string };
  CustomerInfo: { chatKey: string };
  Settings: undefined;
  // v1.264: 1:1 audio call route. callId is the Daily.co room name /
  // Firebase /commonComm/calls/{callId} key. Initiator side navigates
  // here right after creating the room; recipient side navigates here
  // from IncomingCallOverlay after tapping Accept.
  Call: { callId: string };
};
