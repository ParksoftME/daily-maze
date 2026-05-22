import { useState, useEffect } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
  StatusBar,
} from "react-native";
import { supabase } from "./lib/supabase";
import {
  runGoogleOAuthDebug,
  checkExistingSession,
  type OAuthDebugReport,
} from "./lib/auth-debug";

function line(label: string, value: string | boolean | null | undefined) {
  const v =
    value === null || value === undefined
      ? "(null)"
      : typeof value === "boolean"
        ? value
          ? "true"
          : "false"
        : String(value);
  return `${label}: ${v}`;
}

function reportToText(r: OAuthDebugReport | null): string {
  if (!r) return "(로그인 버튼을 눌러 테스트)";
  return [
    line("redirectTo", r.redirectTo),
    line("makeRedirectUri", r.makeRedirectUri),
    line("Linking.createURL", r.linkingCreateURL),
    line("signInError", r.signInError),
    line("urlHasRedirectTo", r.urlHasRedirectTo),
    line("redirectToInUrl", r.redirectToInUrl),
    line("signInUrl", r.signInUrl ? `${r.signInUrl.slice(0, 120)}...` : null),
    line("browserResultType", r.browserResultType),
    line("browserResultUrl", r.browserResultUrl),
    line("hasCode", r.hasCode),
    line("exchangeError", r.exchangeError),
    line("exchangeUserEmail", r.exchangeUserEmail),
    line("getSessionEmail", r.getSessionEmail),
    line("getSessionUserId", r.getSessionUserId),
    line("success", r.success),
    line("finalError", r.finalError),
  ].join("\n");
}

export default function OAuthDebugApp() {
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<OAuthDebugReport | null>(null);
  const [bootErr, setBootErr] = useState<string | null>(null);
  const [existing, setExisting] = useState<string>("확인 중…");

  useEffect(() => {
    checkExistingSession()
      .then((s) => {
        setExisting(
          s.error
            ? `기존 세션 오류: ${s.error}`
            : s.userId
              ? `기존 세션 있음 — ${s.email} (${s.userId})`
              : "기존 세션 없음",
        );
      })
      .catch((e) => {
        setBootErr(e instanceof Error ? e.message : String(e));
        setExisting("기존 세션 확인 실패");
      });
  }, []);

  const onGoogleLogin = async () => {
    setBusy(true);
    setBootErr(null);
    try {
      const r = await runGoogleOAuthDebug();
      setReport(r);
      if (r.finalError) setBootErr(r.finalError);

      const s = await checkExistingSession();
      setExisting(
        s.userId
          ? `기존 세션 — ${s.email} (${s.userId})`
          : s.error
            ? `getSession 오류: ${s.error}`
            : "세션 없음",
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setBootErr(msg);
    } finally {
      setBusy(false);
    }
  };

  const onSignOut = async () => {
    setBusy(true);
    try {
      await supabase.auth.signOut();
      setReport(null);
      setExisting("로그아웃 완료");
      setBootErr(null);
    } catch (e) {
      setBootErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={S.root}>
      <StatusBar barStyle="dark-content" />
      <Text style={S.title}>OAuth 디버그 (Supabase Users 생성)</Text>
      <Text style={S.sub}>{existing}</Text>

      {bootErr != null && (
        <View style={S.errBox}>
          <Text style={S.errTitle}>ERROR</Text>
          <Text style={S.errTxt}>{bootErr}</Text>
        </View>
      )}

      <TouchableOpacity style={S.btn} disabled={busy} onPress={onGoogleLogin}>
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={S.btnTxt}>Google 로그인 (디버그)</Text>
        )}
      </TouchableOpacity>

      <TouchableOpacity style={S.btnOut} disabled={busy} onPress={onSignOut}>
        <Text style={S.btnOutTxt}>로그아웃</Text>
      </TouchableOpacity>

      <ScrollView style={S.logBox} contentContainerStyle={{ paddingBottom: 24 }}>
        <Text style={S.logTxt}>{reportToText(report)}</Text>
      </ScrollView>
    </View>
  );
}

const S = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f5f5f0", paddingTop: 48, paddingHorizontal: 16 },
  title: { fontSize: 18, fontWeight: "900", color: "#222" },
  sub: { fontSize: 12, color: "#666", marginTop: 8, marginBottom: 12 },
  errBox: {
    backgroundColor: "#ffe8e8",
    borderWidth: 1,
    borderColor: "#e88",
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
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
  btnTxt: { color: "#fff", fontWeight: "800", fontSize: 16 },
  btnOut: {
    paddingVertical: 10,
    alignItems: "center",
    marginBottom: 12,
  },
  btnOutTxt: { color: "#666", fontWeight: "600" },
  logBox: {
    flex: 1,
    backgroundColor: "#fff",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#ddd",
    padding: 12,
  },
  logTxt: { fontFamily: "monospace", fontSize: 11, color: "#222", lineHeight: 16 },
});
