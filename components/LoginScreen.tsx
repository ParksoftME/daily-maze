import React from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
} from "react-native";
import { signInWithGoogle } from "../lib/auth";

type Props = {
  busy: boolean;
  error: string | null;
  onBusyChange: (busy: boolean) => void;
  onError: (msg: string | null) => void;
  onLoggedIn: () => void;
};

export default function LoginScreen({
  busy,
  error,
  onBusyChange,
  onError,
  onLoggedIn,
}: Props) {
  const onPressGoogle = async () => {
    onBusyChange(true);
    onError(null);
    try {
      const result = await signInWithGoogle();
      if (!result.ok) {
        if (result.cancelled) return;
        if (result.awaitingLinking) {
          // Expo Go: exp:// 콜백은 App Linking 리스너가 처리
          return;
        }
        onError(result.error ?? "Google 로그인에 실패했어요.");
        return;
      }
      onLoggedIn();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Google 로그인에 실패했어요.");
    } finally {
      onBusyChange(false);
    }
  };

  return (
    <View style={S.root}>
      <Text style={S.title}>🗺️ 데일리 미로</Text>
      <Text style={S.sub}>Google 계정으로 로그인하세요</Text>

      {error != null && <Text style={S.err}>{error}</Text>}

      <TouchableOpacity style={S.googleBtn} disabled={busy} onPress={onPressGoogle}>
        {busy ? (
          <ActivityIndicator color="#333" />
        ) : (
          <Text style={S.googleBtnTxt}>Google로 로그인</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const S = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 24,
    gap: 16,
  },
  title: { fontSize: 28, fontWeight: "900", color: "#222" },
  sub: { fontSize: 14, color: "#666", textAlign: "center", lineHeight: 20 },
  err: { color: "#c8001a", fontSize: 13, textAlign: "center" },
  googleBtn: {
    width: "100%",
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: "center",
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#ddd",
    elevation: 2,
  },
  googleBtnTxt: { fontSize: 17, fontWeight: "800", color: "#333" },
});
