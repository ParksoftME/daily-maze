import * as WebBrowser from "expo-web-browser";
import * as Linking from "expo-linking";
import * as QueryParams from "expo-auth-session/build/QueryParams";
import { makeRedirectUri } from "expo-auth-session";
import { supabase } from "./supabase";

WebBrowser.maybeCompleteAuthSession();

const APP_SCHEME = "daily-maze2";
const AUTH_CALLBACK_PATH = "auth/callback";

/**
 * Expo Go → exp://<host>:<port>/--/auth/callback
 * Dev/Release build → daily-maze2://auth/callback
 */
export function getOAuthRedirectUri(): string {
  const redirectTo = makeRedirectUri({
    scheme: APP_SCHEME,
    path: AUTH_CALLBACK_PATH,
  });
  console.log("redirectTo:", redirectTo);
  console.log("Linking.createURL:", Linking.createURL(AUTH_CALLBACK_PATH));
  return redirectTo;
}

/** Supabase Dashboard → Redirect URLs에 추가할 후보 목록 */
export function getSupabaseRedirectUrlHints(): string[] {
  const primary = getOAuthRedirectUri();
  return [
    primary,
    `${APP_SCHEME}://${AUTH_CALLBACK_PATH}`,
    Linking.createURL(AUTH_CALLBACK_PATH),
    "exp://**",
    "exp://127.0.0.1:8081/--/auth/callback",
    "exp://localhost:8081/--/auth/callback",
  ];
}

async function createSessionFromUrl(url: string) {
  const { params, errorCode } = QueryParams.getQueryParams(url);
  if (errorCode) throw new Error(errorCode);

  if (params.code) {
    const { error } = await supabase.auth.exchangeCodeForSession(params.code);
    if (error) throw error;
    return;
  }

  const access_token = params.access_token;
  const refresh_token = params.refresh_token;
  if (!access_token || !refresh_token) {
    throw new Error("로그인 토큰을 받지 못했어요.");
  }
  const { error } = await supabase.auth.setSession({ access_token, refresh_token });
  if (error) throw error;
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
  return true;
}

export async function signInWithGoogle(): Promise<{ cancelled: boolean }> {
  const redirectTo = getOAuthRedirectUri();

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo,
      skipBrowserRedirect: true,
    },
  });
  if (error) throw error;
  if (!data?.url) throw new Error("OAuth URL이 없습니다.");

  const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
  if (result.type !== "success" || !result.url) return { cancelled: true };

  await createSessionFromUrl(result.url);
  return { cancelled: false };
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}
