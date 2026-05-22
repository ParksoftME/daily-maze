import { supabase } from "./supabase";

export type UserProfile = {
  id: string;
  nickname: string | null;
  short_id: string;
  avatar_url: string | null;
  created_at?: string;
};

const SHORT_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateShortId(len = 6) {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += SHORT_CHARS[Math.floor(Math.random() * SHORT_CHARS.length)];
  }
  return out;
}

export async function fetchProfile(userId: string): Promise<UserProfile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, nickname, short_id, avatar_url, created_at")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  return data as UserProfile | null;
}

export async function ensureProfileRow(userId: string): Promise<UserProfile> {
  const existing = await fetchProfile(userId);
  if (existing) return existing;

  for (let attempt = 0; attempt < 8; attempt++) {
    const short_id = generateShortId(6);
    const { data, error } = await supabase
      .from("profiles")
      .insert({ id: userId, short_id })
      .select("id, nickname, short_id, avatar_url, created_at")
      .single();
    if (!error && data) return data as UserProfile;
    if (error?.code !== "23505") throw error;
  }
  throw new Error("프로필 ID 생성에 실패했어요.");
}

export async function saveNickname(userId: string, nickname: string): Promise<UserProfile> {
  await ensureProfileRow(userId);
  const trimmed = nickname.trim();
  const { data, error } = await supabase
    .from("profiles")
    .update({ nickname: trimmed })
    .eq("id", userId)
    .select("id, nickname, short_id, avatar_url, created_at")
    .single();
  if (error) throw error;
  return data as UserProfile;
}

export type DailyResultRow = {
  diff: string;
  slot: number;
  date: string;
  clear_time: number;
};

export async function fetchTodayResults(userId: string, dateIso: string) {
  const { data, error } = await supabase
    .from("daily_results")
    .select("diff, slot, date, clear_time")
    .eq("user_id", userId)
    .eq("date", dateIso);
  if (error) throw error;
  return (data ?? []) as DailyResultRow[];
}

export async function saveDailyResult(
  userId: string,
  diff: string,
  slot: number,
  dateIso: string,
  clearTime: number,
  trailPts: { x: number; y: number }[],
) {
  const { error } = await supabase.from("daily_results").upsert(
    {
      user_id: userId,
      diff,
      slot,
      date: dateIso,
      clear_time: clearTime,
      trail_data: trailPts,
    },
    { onConflict: "user_id,diff,slot,date" },
  );
  if (error) throw error;
}

export async function fetchStreak(userId: string): Promise<number> {
  const { data, error } = await supabase
    .from("streaks")
    .select("current_streak")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data?.current_streak ?? 0;
}

function yesterdayIso(dateIso: string) {
  const d = new Date(dateIso + "T12:00:00");
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

export async function updateStreakOnClear(userId: string, dateIso: string): Promise<number> {
  const { data: row, error: fetchErr } = await supabase
    .from("streaks")
    .select("current_streak, last_clear_date")
    .eq("user_id", userId)
    .maybeSingle();
  if (fetchErr) throw fetchErr;

  let next = 1;
  if (row?.last_clear_date === dateIso) {
    next = row.current_streak ?? 1;
  } else if (row?.last_clear_date === yesterdayIso(dateIso)) {
    next = (row.current_streak ?? 0) + 1;
  }

  const { error } = await supabase.from("streaks").upsert(
    { user_id: userId, current_streak: next, last_clear_date: dateIso },
    { onConflict: "user_id" },
  );
  if (error) throw error;
  return next;
}

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function mazeKeyFromRow(diff: string, slot: number, daySeed: number) {
  const dateNum = daySeed;
  return `${diff}_${dateNum}_${slot}`;
}
