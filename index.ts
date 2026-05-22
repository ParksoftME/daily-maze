import "react-native-gesture-handler";
import { registerRootComponent } from "expo";

// OAuth 디버그 전용 — Users 생성 확인 후 App 으로 되돌리세요
import OAuthDebugApp from "./OAuthDebugApp";

registerRootComponent(OAuthDebugApp);
