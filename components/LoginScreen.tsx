import React from "react";
import {
  View,
  Text,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  StyleSheet,
  ScrollView,
} from "react-native";
import * as WebBrowser from "expo-web-browser";
import * as Google from "expo-auth-session/providers/google";
import {
  sendEmailOtp,
  verifyEmailOtp,
  signInWithGoogleIdToken,
  getCurrentSessionUser,
} from "../lib/auth-expo-go";

WebBrowser.maybeCompleteAuthSession();

function GoogleSignInButton({
  disabled,
  onSuccess,
  onError,
}: {
  disabled: boolean;
  onSuccess: () => void;
  onError: (msg: string) => void;
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
      if (response.type === "cancel" || response.type === "dismiss") return;
      if (response.type !== "success") {
        onError(`Google 로그인 실패 (${response.type})`);
        return;
      }
      const idToken =
        response.params?.id_token ?? response.authentication?.idToken ?? null;
      if (!idToken) {
        onError("Google id_token을 받지 못했어요.");
        return;
      }
      try {
        await signInWithGoogleIdToken(idToken);
        onSuccess();
      } catch (e) {
        onError(e instanceof Error ? e.message : "Google 로그인 실패");
      }
    })();
  }, [response, onSuccess, onError]);

  if (!webClientId) return null;

  return (
    <TouchableOpacity
      style={S.googleBtn}
      disabled={disabled || !request}
      onPress={() => promptAsync()}>
      <Text style={S.googleBtnTxt}>Google로 로그인</Text>
    </TouchableOpacity>
  );
}

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
  const [email, setEmail] = React.useState("");
  const [otp, setOtp] = React.useState("");
  const [otpSent, setOtpSent] = React.useState(false);

  const onSendOtp = async () => {
    if (!email.includes("@")) {
      onError("올바른 이메일을 입력해 주세요.");
      return;
    }
    onBusyChange(true);
    onError(null);
    try {
      await sendEmailOtp(email);
      setOtpSent(true);
    } catch (e) {
      onError(e instanceof Error ? e.message : "OTP 전송 실패");
    } finally {
      onBusyChange(false);
    }
  };

  const onVerifyOtp = async () => {
    if (otp.length < 6) {
      onError("메일의 6자리 코드를 입력해 주세요.");
      return;
    }
    onBusyChange(true);
    onError(null);
    try {
      await verifyEmailOtp(email, otp);
      const user = await getCurrentSessionUser();
      if (!user) throw new Error("세션이 생성되지 않았어요.");
      onLoggedIn();
    } catch (e) {
      onError(e instanceof Error ? e.message : "OTP 확인 실패");
    } finally {
      onBusyChange(false);
    }
  };

  return (
    <ScrollView
      contentContainerStyle={S.scroll}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}>
      <Text style={S.title}>🗺️ 데일리 미로</Text>
      <Text style={S.sub}>로그인하고 오늘의 미로 기록을 저장하세요.</Text>

      {error != null && <Text style={S.err}>{error}</Text>}

      <Text style={S.label}>이메일 로그인</Text>
      <TextInput
        style={S.input}
        placeholder="email@example.com"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        keyboardType="email-address"
        editable={!busy}
      />
      <TouchableOpacity style={S.btn} disabled={busy} onPress={onSendOtp}>
        {busy && !otpSent ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={S.btnTxt}>인증 메일 보내기</Text>
        )}
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
            editable={!busy}
          />
          <TouchableOpacity style={S.btn} disabled={busy} onPress={onVerifyOtp}>
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={S.btnTxt}>코드 확인</Text>
            )}
          </TouchableOpacity>
        </>
      )}

      <View style={S.dividerRow}>
        <View style={S.dividerLine} />
        <Text style={S.dividerTxt}>또는</Text>
        <View style={S.dividerLine} />
      </View>

      <GoogleSignInButton
        disabled={busy}
        onSuccess={onLoggedIn}
        onError={(msg) => onError(msg)}
      />
    </ScrollView>
  );
}

const S = StyleSheet.create({
  scroll: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: 20,
    paddingVertical: 32,
    gap: 10,
  },
  title: { fontSize: 28, fontWeight: "900", textAlign: "center", color: "#222" },
  sub: { fontSize: 14, color: "#666", textAlign: "center", lineHeight: 20 },
  label: { fontSize: 13, fontWeight: "700", color: "#444", marginTop: 8 },
  err: { color: "#c8001a", fontSize: 13, textAlign: "center" },
  input: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    backgroundColor: "#fff",
  },
  btn: {
    backgroundColor: "#1a5ce6",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  btnTxt: { color: "#fff", fontSize: 16, fontWeight: "800" },
  googleBtn: {
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#ddd",
  },
  googleBtnTxt: { fontSize: 16, fontWeight: "800", color: "#333" },
  dividerRow: { flexDirection: "row", alignItems: "center", gap: 10, marginVertical: 8 },
  dividerLine: { flex: 1, height: 1, backgroundColor: "#ddd" },
  dividerTxt: { fontSize: 12, color: "#999" },
});
