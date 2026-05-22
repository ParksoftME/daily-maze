import React, { Component, type ReactNode } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
  StatusBar,
  TextInput,
} from "react-native";
import * as WebBrowser from "expo-web-browser";
import * as Google from "expo-auth-session/providers/google";

WebBrowser.maybeCompleteAuthSession();

type ErrorBoundaryState = { error: string | null };

class ErrorBoundary extends Component<
  { children: ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(err: unknown): ErrorBoundaryState {
    return {
      error: err instanceof Error ? err.message : String(err),
    };
  }

  render() {
    if (this.state.error) {
      return (
        <View style={S.root}>
          <StatusBar barStyle="dark-content" />
          <Text style={S.title}>OAuth Debug Screen</Text>
          <View style={S.errBox}>
            <Text style={S.errTitle}>RENDER ERROR</Text>
            <Text style={S.errTxt}>{this.state.error}</Text>
          </View>
        </View>
      );
    }
    return this.props.children;
  }
}

/** expo-auth-session Google → Supabase signInWithIdToken (Expo Go용) */
function GoogleExpoLogin({
  onStatus,
}: {
  onStatus: (msg: string, isError?: boolean) => void;
}) {
  const webClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;

  const [request, response, promptAsync] = Google.useAuthRequest(
    webClientId
      ? {
          webClientId,
          iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? webClientId,
          androidClientId:
            process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID ?? webClientId,
        }
      : { clientId: "missing" },
  );

  React.useEffect(() => {
    if (!response) return;

    (async () => {
      console.log("[Google] response.type:", response.type);
      if (response.type === "success") {
        console.log("[Google] response.params:", response.params);
      }

      if (response.type === "cancel" || response.type === "dismiss") {
        onStatus("Google 로그인 취소됨");
        return;
      }
      if (response.type !== "success") {
        onStatus(`Google 실패: type=${response.type}`, true);
        return;
      }

      const successRes = response;
      const idToken =
        successRes.params?.id_token ??
        successRes.authentication?.idToken ??
        null;

      console.log("[Google] id_token exists:", !!idToken);

      if (!idToken) {
        onStatus(
          "Google id_token 없음. Web Client ID·Supabase Google provider 확인.",
          true,
        );
        return;
      }

      try {
        const { signInWithGoogleIdToken, getCurrentSessionUser } = await import(
          "./lib/auth-expo-go"
        );
        await signInWithGoogleIdToken(idToken);
        const user = await getCurrentSessionUser();
        console.log("[Google] Supabase user:", user?.email);
        onStatus(`Google 로그인 성공: ${user?.email ?? user?.id}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log("[Google] Supabase signInWithIdToken error:", msg);
        onStatus(msg, true);
      }
    })();
  }, [response, onStatus]);

  if (!webClientId) {
    return (
      <Text style={S.hint}>
        Google: .env에 EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID 없음 → 아래 이메일 OTP 사용
      </Text>
    );
  }

  return (
    <TouchableOpacity
      style={[S.btn, S.btnGoogle]}
      disabled={!request}
      onPress={() => {
        onStatus("Google 로그인 창 여는 중…");
        promptAsync();
      }}>
      <Text style={S.btnTxt}>Google (expo-auth-session)</Text>
    </TouchableOpacity>
  );
}

function OAuthDebugScreen() {
  const [status, setStatus] = React.useState("ready");
  const [busy, setBusy] = React.useState(false);
  const [screenErr, setScreenErr] = React.useState<string | null>(null);
  const [log, setLog] = React.useState<string>("");
  const [email, setEmail] = React.useState("");
  const [otp, setOtp] = React.useState("");
  const [otpSent, setOtpSent] = React.useState(false);
  const [sessionEmail, setSessionEmail] = React.useState<string | null>(null);

  const appendLog = (line: string) => {
    console.log(line);
    setLog((prev) => `${prev}${prev ? "\n" : ""}${line}`);
  };

  const setStatusMsg = (msg: string, isError = false) => {
    setStatus(isError ? "error" : "ok");
    if (isError) setScreenErr(msg);
    else {
      setScreenErr(null);
      appendLog(msg);
    }
  };

  const refreshSession = async () => {
    const { getCurrentSessionUser } = await import("./lib/auth-expo-go");
    const user = await getCurrentSessionUser();
    setSessionEmail(user?.email ?? null);
    if (user) appendLog(`세션: ${user.email} (${user.id})`);
    else appendLog("세션 없음");
  };

  const onSendOtp = async () => {
    if (!email.includes("@")) {
      setStatusMsg("올바른 이메일을 입력하세요.", true);
      return;
    }
    setBusy(true);
    setStatus("sending-otp");
    setScreenErr(null);
    try {
      const { sendEmailOtp } = await import("./lib/auth-expo-go");
      await sendEmailOtp(email);
      setOtpSent(true);
      setStatusMsg(`OTP 전송됨: ${email} (메일 6자리 코드 입력)`);
    } catch (e) {
      setStatusMsg(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  };

  const onVerifyOtp = async () => {
    if (otp.length < 6) {
      setStatusMsg("6자리 OTP 코드를 입력하세요.", true);
      return;
    }
    setBusy(true);
    setStatus("verifying");
    setScreenErr(null);
    try {
      const { verifyEmailOtp, getCurrentSessionUser } = await import("./lib/auth-expo-go");
      await verifyEmailOtp(email, otp);
      const user = await getCurrentSessionUser();
      setSessionEmail(user?.email ?? null);
      setStatusMsg(`로그인 성공! ${user?.email} → Supabase Users 확인`);
      setStatus("success");
    } catch (e) {
      setStatusMsg(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  };

  const onSignOut = async () => {
    setBusy(true);
    try {
      const { signOutSupabase } = await import("./lib/auth-expo-go");
      await signOutSupabase();
      setSessionEmail(null);
      setOtpSent(false);
      setStatus("ready");
      setScreenErr(null);
      appendLog("로그아웃 완료");
    } catch (e) {
      setStatusMsg(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  };

  const envHint = React.useMemo(() => {
    const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
    const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    const g = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
    if (!url || !key) return "WARN: EXPO_PUBLIC_SUPABASE_* 없음";
    return `env OK | Google Web ID: ${g ? "있음" : "없음 → OTP 사용"}`;
  }, []);

  return (
    <View style={S.root}>
      <StatusBar barStyle="dark-content" />
      <Text style={S.title}>OAuth Debug Screen</Text>
      <Text style={S.status}>status: {status}</Text>
      <Text style={S.sub}>{envHint}</Text>
      {sessionEmail != null && (
        <Text style={S.session}>logged in: {sessionEmail}</Text>
      )}

      {screenErr != null && (
        <View style={S.errBox}>
          <Text style={S.errTitle}>ERROR</Text>
          <Text style={S.errTxt}>{screenErr}</Text>
        </View>
      )}

      <Text style={S.section}>① 이메일 OTP (Expo Go 권장 — 리다이렉트 불필요)</Text>
      <TextInput
        style={S.input}
        placeholder="email@example.com"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        keyboardType="email-address"
      />
      <TouchableOpacity style={S.btn} disabled={busy} onPress={onSendOtp}>
        <Text style={S.btnTxt}>{busy ? "…" : "OTP 메일 보내기"}</Text>
      </TouchableOpacity>
      {otpSent && (
        <>
          <TextInput
            style={S.input}
            placeholder="6자리 코드"
            value={otp}
            onChangeText={setOtp}
            keyboardType="number-pad"
            maxLength={8}
          />
          <TouchableOpacity style={S.btn} disabled={busy} onPress={onVerifyOtp}>
            <Text style={S.btnTxt}>OTP 확인 → Supabase 로그인</Text>
          </TouchableOpacity>
        </>
      )}

      <Text style={S.section}>② Google (expo-auth-session + idToken)</Text>
      <GoogleExpoLogin onStatus={setStatusMsg} />

      <TouchableOpacity style={S.btnOut} disabled={busy} onPress={refreshSession}>
        <Text style={S.btnOutTxt}>세션 새로고침</Text>
      </TouchableOpacity>
      <TouchableOpacity style={S.btnOut} disabled={busy} onPress={onSignOut}>
        <Text style={S.btnOutTxt}>로그아웃</Text>
      </TouchableOpacity>

      <ScrollView style={S.logBox} contentContainerStyle={{ paddingBottom: 24 }}>
        <Text style={S.logTxt}>{log || "(로그 없음)"}</Text>
      </ScrollView>
    </View>
  );
}

export default function OAuthDebugApp() {
  return (
    <ErrorBoundary>
      <OAuthDebugScreen />
    </ErrorBoundary>
  );
}

const S = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f5f5f0", paddingTop: 48, paddingHorizontal: 16 },
  title: { fontSize: 20, fontWeight: "900", color: "#222" },
  status: { fontSize: 14, fontWeight: "700", color: "#1a5ce6", marginTop: 8 },
  sub: { fontSize: 11, color: "#888", marginTop: 4 },
  session: { fontSize: 13, color: "#2e7d32", fontWeight: "700", marginTop: 6, marginBottom: 8 },
  section: { fontSize: 13, fontWeight: "800", color: "#444", marginTop: 12, marginBottom: 8 },
  hint: { fontSize: 12, color: "#888", marginBottom: 8 },
  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    padding: 12,
    backgroundColor: "#fff",
    marginBottom: 8,
    fontSize: 15,
  },
  errBox: {
    backgroundColor: "#ffe8e8",
    borderWidth: 1,
    borderColor: "#e88",
    borderRadius: 8,
    padding: 12,
    marginVertical: 8,
  },
  errTitle: { fontWeight: "900", color: "#a00", marginBottom: 4 },
  errTxt: { color: "#800", fontSize: 13 },
  btn: {
    backgroundColor: "#1a5ce6",
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
    marginBottom: 8,
  },
  btnGoogle: { backgroundColor: "#4285F4" },
  btnTxt: { color: "#fff", fontWeight: "800", fontSize: 15 },
  btnOut: { paddingVertical: 8, alignItems: "center" },
  btnOutTxt: { color: "#666", fontWeight: "600", fontSize: 13 },
  logBox: {
    flex: 1,
    marginTop: 8,
    backgroundColor: "#fff",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#ddd",
    padding: 12,
  },
  logTxt: { fontSize: 11, color: "#222", lineHeight: 16 },
});
