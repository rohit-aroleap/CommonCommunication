import "react-native-gesture-handler";
// v1.268: side-effect import that registers our Expo background
// notification task. MUST happen at module-load time (before
// registerRootComponent) so the task is known to the OS when it spins
// up a headless JS runtime to deliver a data-only push while the app
// is killed. Moving this into a component or useEffect breaks
// killed-state delivery silently.
import "./src/notifications/backgroundNotificationTask";
import { registerRootComponent } from "expo";
import App from "./App";

registerRootComponent(App);
