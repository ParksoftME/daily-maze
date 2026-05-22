import * as WebBrowser from "expo-web-browser";
import * as Linking from "expo-linking";
import * as QueryParams from "expo-auth-session/build/QueryParams";
import { makeRedirectUri } from "expo-auth-session";
import { supabase } from "./supabase";

WebBrowser.maybeCompleteAuthSession();

const APP_SCHEME = "daily-maze2";
const AUTH_CALLBACK_PATH = "auth/callback";

let oauthExchangeInFlight = false;

export function getOAuthRedirectUri(): string {
  const fromMake = makeRedirectUri({
    scheme: APP_SCHEME,
    path: AUTH_CALLBACK_PATH,
  });
  const fromLinking = Linking.createURL(AUTH_CALLBACK_PATH);

  const redirectTo =
    fromMake.startsWith("exp://") && fromMake.includes("auth/callback")
      ? fromMake
      : fromLinking.startsWith("exp://")
        ? fromLinking
        : fromMake;

  console.log("redirectTo:", redirectTo);
  return redirectTo;
}

export function isOAuthCallbackUrl(url: string): boolean {
  return (
    url.includes(AUTH_CALLBACK_PATH) ||
    url.includes("code=") ||
    url.includes("access_token=")
  );
}

function parseOAuthCallback(url: string) {
  const { params, errorCode } = QueryParams.getQueryParams(url);
  const oauthError =
    params.error_description ?? params.error ?? errorCode ?? null;
  return { params, oauthError };
}

/** Linking / openAuthSessionAsync 콜백 URL → Supabase 세션 */
export async function completeOAuthFromUrl(url: string) {
  if (!isOAuthCallbackUrl(url)) {
    return false;
  }

  if (oauthExchangeInFlight) {
    console.log("[OAuth] completeOAuthFromUrl skipped (in flight)");
    return false;
  }
  oauthExchangeInFlight = true;

  try {
    console.log("[Linking] callback url:", url);
    const { params, oauthError } = parseOAuthCallback(url);
    console.log("[Linking] has code:", !!params.code);

    if (oauthError) {
      throw new Error(String(oauthError));
    }

    if (params.code) {
      const { data, error } = await supabase.auth.exchangeCodeForSession(params.code);
      console.log("[Linking] exchangeCodeForSession error:", error?.message ?? null);
      console.log("[Linking] exchangeCodeForSession user:", data?.user?.email ?? null);
      if (error) throw error;
      if (!data.session) throw new Error("세션이 비어 있습니다.");
      return true;
    }

    const { access_token, refresh_token } = params;
    if (access_token && refresh_token) {
      const { error } = await supabase.auth.setSession({ access_token, refresh_token });
      if (error) throw error;
      return true;
    }

    throw new Error("콜백 URL에 code가 없습니다.");
  } finally {
    oauthExchangeInFlight = false;
  }
}

export type GoogleSignInResult =
  | { ok: true; userId: string; email: string | null }
  | { ok: false; cancelled: boolean; awaitingLinking?: boolean; error?: string };

export async function signInWithGoogle(): Promise<GoogleSignInResult> {
  const redirectTo = getOAuthRedirectUri();

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo, skipBrowserRedirect: true },
  });

  console.log("[OAuth] signInWithOAuth error:", error?.message ?? null);
  console.log("[OAuth] data.url:", data?.url ?? null);

  if (error) {
    return { ok: false, cancelled: false, error: error.message };
  }
  if (!data?.url) {
    return { ok: false, cancelled: false, error: "OAuth URL이 없습니다." };
  }

  const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
  console.log("[OAuth] openAuthSessionAsync type:", result.type);
  console.log("[OAuth] openAuthSessionAsync url:", "url" in result ? result.url : null);

  if (result.type === "success" && result.url) {
    try {
      await completeOAuthFromUrl(result.url);
      const { data: sess } = await supabase.auth.getSession();
      if (!sess.session?.user) {
        return { ok: false, cancelled: false, error: "세션을 찾을 수 없습니다." };
      }
      return {
        ok: true,
        userId: sess.session.user.id,
        email: sess.session.user.email ?? null,
      };
    } catch (e) {
      return {
        ok: false,
        cancelled: false,
        error: e instanceof Error ? e.message : "세션 교환 실패",
      };
    }
  }

  if (result.type === "cancel") {
    return { ok: false, cancelled: true };
  }

  // Expo Go: dismiss 후 exp:// 딥링크로 복귀 → App Linking 리스너가 code 교환
  console.log("[OAuth] awaiting Linking callback (type=", result.type, ")");
  return { ok: false, cancelled: false, awaitingLinking: true };
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}
