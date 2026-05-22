import * as WebBrowser from "expo-web-browser";
import * as Linking from "expo-linking";
import * as QueryParams from "expo-auth-session/build/QueryParams";
import { makeRedirectUri } from "expo-auth-session";
import { supabase } from "./supabase";

WebBrowser.maybeCompleteAuthSession();

const APP_SCHEME = "daily-maze2";
const AUTH_CALLBACK_PATH = "auth/callback";

export type OAuthDebugReport = {
  redirectTo: string;
  makeRedirectUri: string;
  linkingCreateURL: string;
  signInError: string | null;
  signInUrl: string | null;
  urlHasRedirectTo: boolean;
  redirectToInUrl: string | null;
  browserResultType: string;
  browserResultUrl: string | null;
  hasCode: boolean;
  exchangeError: string | null;
  exchangeUserEmail: string | null;
  getSessionEmail: string | null;
  getSessionUserId: string | null;
  finalError: string | null;
  success: boolean;
};

function emptyReport(): OAuthDebugReport {
  return {
    redirectTo: "",
    makeRedirectUri: "",
    linkingCreateURL: "",
    signInError: null,
    signInUrl: null,
    urlHasRedirectTo: false,
    redirectToInUrl: null,
    browserResultType: "",
    browserResultUrl: null,
    hasCode: false,
    exchangeError: null,
    exchangeUserEmail: null,
    getSessionEmail: null,
    getSessionUserId: null,
    finalError: null,
    success: false,
  };
}

function resolveRedirectTo(): {
  redirectTo: string;
  makeUri: string;
  linkingUri: string;
} {
  const makeUri = makeRedirectUri({
    scheme: APP_SCHEME,
    path: AUTH_CALLBACK_PATH,
  });
  const linkingUri = Linking.createURL(AUTH_CALLBACK_PATH);
  const redirectTo =
    makeUri.startsWith("exp://") && makeUri.includes("auth/callback")
      ? makeUri
      : linkingUri.startsWith("exp://")
        ? linkingUri
        : makeUri;
  return { redirectTo, makeUri, linkingUri };
}

function parseRedirectToFromAuthUrl(authUrl: string): string | null {
  try {
    const u = new URL(authUrl);
    const raw = u.searchParams.get("redirect_to");
    return raw ? decodeURIComponent(raw) : null;
  } catch {
    const m = authUrl.match(/redirect_to=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }
}

function logReport(r: OAuthDebugReport) {
  console.log("redirectTo:", r.redirectTo);
  console.log("signInWithOAuth data.url:", r.signInUrl);
  console.log("openAuthSessionAsync result.type:", r.browserResultType);
  console.log("openAuthSessionAsync result.url:", r.browserResultUrl);
  console.log("callback code exists:", r.hasCode);
  console.log("exchangeCodeForSession error:", r.exchangeError);
  console.log("exchangeCodeForSession user email:", r.exchangeUserEmail);
  console.log("getSession user email:", r.getSessionEmail);
}

export async function runGoogleOAuthDebug(): Promise<OAuthDebugReport> {
  const r = emptyReport();
  const { redirectTo, makeUri, linkingUri } = resolveRedirectTo();
  r.redirectTo = redirectTo;
  r.makeRedirectUri = makeUri;
  r.linkingCreateURL = linkingUri;

  try {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo,
        skipBrowserRedirect: true,
      },
    });

    r.signInError = error?.message ?? null;
    r.signInUrl = data?.url ?? null;

    if (r.signInUrl) {
      r.redirectToInUrl = parseRedirectToFromAuthUrl(r.signInUrl);
      r.urlHasRedirectTo = r.redirectToInUrl != null && r.redirectToInUrl.length > 0;
    }

    if (error) {
      r.finalError = error.message;
      logReport(r);
      return r;
    }
    if (!r.signInUrl) {
      r.finalError = "signInWithOAuth: data.url 없음 (redirectTo 미전달 가능)";
      logReport(r);
      return r;
    }

    if (!r.urlHasRedirectTo) {
      r.finalError =
        "data.url에 redirect_to 없음 → signInWithOAuth options.redirectTo 전달 실패";
      logReport(r);
      return r;
    }

    const result = await WebBrowser.openAuthSessionAsync(r.signInUrl, redirectTo);
    r.browserResultType = result.type;
    r.browserResultUrl = "url" in result ? (result.url ?? null) : null;

    if (result.type !== "success" || !r.browserResultUrl) {
      r.finalError =
        result.type === "cancel" || result.type === "dismiss"
          ? "브라우저 로그인 취소됨"
          : `브라우저 결과 type=${result.type}, url 없음`;
      logReport(r);
      return r;
    }

    const { params, errorCode } = QueryParams.getQueryParams(r.browserResultUrl);
    const oauthErr = params.error_description ?? params.error ?? errorCode;
    if (oauthErr) {
      r.finalError = String(oauthErr);
      logReport(r);
      return r;
    }

    r.hasCode = !!params.code;

    if (!r.hasCode) {
      r.finalError =
        "openAuthSessionAsync result.url에 code= 없음 → Redirect URL 설정 문제 (Supabase에 exp://.../--/auth/callback 추가)";
      logReport(r);
      return r;
    }

    const { data: exData, error: exErr } = await supabase.auth.exchangeCodeForSession(
      params.code!,
    );
    r.exchangeError = exErr?.message ?? null;
    r.exchangeUserEmail = exData?.user?.email ?? null;

    if (exErr) {
      r.finalError = exErr.message;
      logReport(r);
      return r;
    }

    const { data: sessData, error: sessErr } = await supabase.auth.getSession();
    if (sessErr) {
      r.finalError = sessErr.message;
      logReport(r);
      return r;
    }

    r.getSessionEmail = sessData.session?.user?.email ?? null;
    r.getSessionUserId = sessData.session?.user?.id ?? null;

    if (!r.getSessionUserId) {
      r.finalError = "exchange 성공했으나 getSession에 user 없음";
      logReport(r);
      return r;
    }

    r.success = true;
    r.finalError = null;
    logReport(r);
    return r;
  } catch (e) {
    r.finalError = e instanceof Error ? e.message : String(e);
    logReport(r);
    return r;
  }
}

export async function checkExistingSession(): Promise<{
  email: string | null;
  userId: string | null;
  error: string | null;
}> {
  const { data, error } = await supabase.auth.getSession();
  return {
    email: data.session?.user?.email ?? null,
    userId: data.session?.user?.id ?? null,
    error: error?.message ?? null,
  };
}
