// Navigator param lists. Kept separate from the screen files so screens can
// import their own props type without circular deps.

export type RootStackParamList = {
  Tabs: undefined;
  Chats: undefined;
  Tickets: undefined;
  Thread: { chatKey: string; initialTitle?: string };
  CustomerInfo: { chatKey: string };
};
