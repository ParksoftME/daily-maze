import * as WebBrowser from "expo-web-browser";
import * as Linking from "expo-linking";
import * as QueryParams from "expo-auth-session/build/QueryParams";
import { makeRedirectUri } from "expo-auth-session";
import { supabase } from "./supabase";

WebBrowser.maybeCompleteAuthSession();

const APP_SCHEME = "daily-maze2";
const AUTH_CALLBACK_PATH = "auth/callback";

/** OAuth code는 1회용 — 중복 exchange 방지 */
let oauthExchangeInFlight = false;

/**
 * Expo Go → exp://<host>:<port>/--/auth/callback
 * Dev/Release build → daily-maze2://auth/callback
 */
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
  console.log("makeRedirectUri:", fromMake);
  console.log("Linking.createURL:", fromLinking);
  return redirectTo;
}

function parseOAuthCallback(url: string) {
  const { params, errorCode } = QueryParams.getQueryParams(url);
  const oauthError =
    params.error_description ?? params.error ?? errorCode ?? null;
  return { params, oauthError };
}

async function createSessionFromUrl(url: string) {
  if (oauthExchangeInFlight) {
    console.log("[OAuth] createSessionFromUrl skipped (already in flight)");
    return;
  }
  oauthExchangeInFlight = true;

  try {
    console.log("[OAuth] createSessionFromUrl url:", url);
    const { params, oauthError } = parseOAuthCallback(url);
    console.log("[OAuth] parsed params keys:", Object.keys(params));
    console.log("[OAuth] has code:", !!params.code);
    console.log("[OAuth] has access_token:", !!params.access_token);

    if (oauthError) {
      throw new Error(String(oauthError));
    }

    if (params.code) {
      console.log("[OAuth] exchangeCodeForSession start, code length:", params.code.length);
      const { data, error } = await supabase.auth.exchangeCodeForSession(params.code);
      console.log("[OAuth] exchangeCodeForSession error:", error?.message ?? null);
      console.log("[OAuth] exchangeCodeForSession user:", data?.user?.email ?? null);
      if (error) throw error;
      if (!data.session) {
        throw new Error("exchangeCodeForSession: 세션이 비어 있습니다.");
      }
      return;
    }

    const access_token = params.access_token;
    const refresh_token = params.refresh_token;
    if (access_token && refresh_token) {
      console.log("[OAuth] setSession from access_token");
      const { error } = await supabase.auth.setSession({ access_token, refresh_token });
      if (error) throw error;
      return;
    }

    throw new Error(
      "콜백 URL에 code 또는 access_token이 없습니다. Supabase Redirect URLs에 exp://.../--/auth/callback 가 등록되어 있는지 확인하세요.",
    );
  } finally {
    oauthExchangeInFlight = false;
  }
}

export async function verifySupabaseSession() {
  const { data, error } = await supabase.auth.getSession();
  console.log("[OAuth] getSession error:", error?.message ?? null);
  console.log("[OAuth] getSession user:", data.session?.user?.email ?? null);
  if (error) throw error;
  return data.session;
}

export type GoogleSignInResult =
  | { ok: true; userId: string; email: string | null }
  | { ok: false; cancelled: boolean; error?: string };

export async function signInWithGoogle(): Promise<GoogleSignInResult> {
  const redirectTo = getOAuthRedirectUri();

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo,
      skipBrowserRedirect: true,
    },
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

  if (result.type !== "success" || !result.url) {
    return { ok: false, cancelled: result.type === "cancel" || result.type === "dismiss" };
  }

  const { params } = parseOAuthCallback(result.url);
  console.log("[OAuth] callback has code:", !!params.code);

  try {
    await createSessionFromUrl(result.url);
    const session = await verifySupabaseSession();
    if (!session?.user) {
      return {
        ok: false,
        cancelled: false,
        error: "세션 교환 후 사용자 정보를 찾을 수 없습니다.",
      };
    }
    return {
      ok: true,
      userId: session.user.id,
      email: session.user.email ?? null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "로그인 처리에 실패했어요.";
    console.log("[OAuth] signInWithGoogle failed:", msg);
    return { ok: false, cancelled: false, error: msg };
  }
}

export async function handleOAuthRedirectUrl(url: string): Promise<boolean> {
  if (
    !url.includes(AUTH_CALLBACK_PATH) &&
    !url.includes("access_token=") &&
    !url.includes("code=")
  ) {
    return false;
  }
  await createSessionFromUrl(url);
  await verifySupabaseSession();
  return true;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}
