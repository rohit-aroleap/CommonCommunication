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
  // v1.292: textOnly forces a daily-workout group's thread to hide media
  // (set when opened from the everyday inbox rather than the Daily tab).
  Thread: {
    chatKey: string;
    initialTitle?: string;
    anchorMsgKey?: string;
    textOnly?: boolean;
    // v1.336: which channel tab to open on. The Chats list passes its
    // current Periskope/Wati toggle so opening a customer lands on the
    // same channel you were viewing (falls back to Periskope if the
    // member lacks Wati access on this chat).
    initialChannel?: "periskope" | "wati";
    // v1.295: "Reply privately to customer" — open the member's 1:1
    // thread with a pending cross-chat reply quoting their group message.
    // The thread consumes this on mount, sets it as the reply target, and
    // the next send carries sourceChatKey back to the originating group.
    replyPrivatelyTo?: {
      msgKey: string;
      text: string;
      senderName: string | null;
      senderPhone: string | null;
      periskopeMsgId: string | null;
      sourceChatKey: string;
    };
  };
  CustomerInfo: { chatKey: string };
  Settings: undefined;
  // v1.264: 1:1 audio call route. callId is the Daily.co room name /
  // Firebase /commonComm/calls/{callId} key. Initiator side navigates
  // here right after creating the room; recipient side navigates here
  // from IncomingCallOverlay after tapping Accept.
  Call: { callId: string };
};
