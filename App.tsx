import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  useWindowDimensions,
  StatusBar,
  Modal,
  AppState,
  Animated,
  ScrollView,
  TextInput,
  ActivityIndicator,
  type AppStateStatus,
} from "react-native";
import * as Linking from "expo-linking";
import {
  signInWithGoogle,
  signOut,
  handleOAuthRedirectUrl,
  getOAuthRedirectUri,
} from "./lib/auth";
import { supabase } from "./lib/supabase";
import {
  ensureProfileRow,
  fetchStreak,
  fetchTodayResults,
  saveDailyResult,
  saveNickname,
  todayIso,
  updateStreakOnClear,
  type UserProfile,
} from "./lib/profile";
import {
  Canvas,
  Path,
  Group,
  Skia,
  Image,
  Rect,
  ImageShader,
  useImage,
  type SkImage,
  type SkPath,
} from "@shopify/react-native-skia";
import { GestureDetector, Gesture, GestureHandlerRootView } from "react-native-gesture-handler";
import { BlurView } from "expo-blur";
import AsyncStorage from "@react-native-async-storage/async-storage";

// ── Maze ──────────────────────────────────────────────────────────────────────
function mkRand(seed: number) {
  let s = seed >>> 0;
  return () => { s = Math.imul(1664525, s) + 1013904223 >>> 0; return s / 0x100000000; };
}
function makeMaze(cols: number, rows: number, seed: number): number[][] {
  const rand = mkRand(seed);
  const DIRS = [
    {dx:0,dy:-1,b:1,o:4},{dx:1,dy:0,b:2,o:8},
    {dx:0,dy:1,b:4,o:1},{dx:-1,dy:0,b:8,o:2},
  ];
  const cells = Array.from({length:rows}, () => new Array(cols).fill(0));
  const vis   = Array.from({length:rows}, () => new Array(cols).fill(false));
  function carve(x: number, y: number) {
    vis[y][x] = true;
    for (const d of [...DIRS].sort(() => rand()-0.5)) {
      const nx=x+d.dx, ny=y+d.dy;
      if (nx>=0&&ny>=0&&nx<cols&&ny<rows&&!vis[ny][nx]) {
        cells[y][x]|=d.b; cells[ny][nx]|=d.o; carve(nx,ny);
      }
    }
  }
  carve(0,0);
  return cells;
}

// ── Wall AABB ─────────────────────────────────────────────────────────────────
interface Wall { x:number; y:number; w:number; h:number; }

function buildWalls(maze: number[][], cols: number, rows: number, cs: number, ox: number, oy: number): Wall[][][] {
  const T = Math.max(2, Math.round(cs * 0.09));
  const list: Wall[] = [];
  const add = (x:number,y:number,w:number,h:number) => list.push({x,y,w,h});
  for (let row=0; row<rows; row++) {
    for (let col=0; col<cols; col++) {
      const cell=maze[row][col], px=ox+col*cs, py=oy+row*cs;
      if (!(cell&1)) add(px-T, py-T, cs+2*T, 2*T);
      if (!(cell&8)) add(px-T, py-T, 2*T, cs+2*T);
      if (row===rows-1&&!(cell&4)) add(px-T, py+cs-T, cs+2*T, 2*T);
      if (col===cols-1&&!(cell&2)) add(px+cs-T, py-T, 2*T, cs+2*T);
    }
  }
  const grid: Wall[][][] = Array.from({length:rows}, () => Array.from({length:cols}, () => []));
  for (const w of list) {
    const c0=Math.max(0,Math.floor((w.x-ox)/cs)-1), c1=Math.min(cols-1,Math.floor((w.x+w.w-ox)/cs)+1);
    const r0=Math.max(0,Math.floor((w.y-oy)/cs)-1), r1=Math.min(rows-1,Math.floor((w.y+w.h-oy)/cs)+1);
    for (let r=r0;r<=r1;r++) for (let c=c0;c<=c1;c++) grid[r][c].push(w);
  }
  return grid;
}

function pushOut(cx:number,cy:number,r:number,wx:number,wy:number,ww:number,wh:number) {
  const nx=Math.max(wx,Math.min(wx+ww,cx)), ny=Math.max(wy,Math.min(wy+wh,cy));
  const dx=cx-nx, dy=cy-ny, d2=dx*dx+dy*dy;
  if (d2>=r*r) return null;
  if (d2<0.0001) {
    const dL=cx-wx,dR=wx+ww-cx,dT=cy-wy,dB=wy+wh-cy,m=Math.min(dL,dR,dT,dB);
    if(m===dL) return{px:-(dL+r),py:0,nx:-1,ny:0};
    if(m===dR) return{px:dR+r,py:0,nx:1,ny:0};
    if(m===dT) return{px:0,py:-(dT+r),nx:0,ny:-1};
    return{px:0,py:dB+r,nx:0,ny:1};
  }
  const d=Math.sqrt(d2),ov=r-d;
  return{px:(dx/d)*ov,py:(dy/d)*ov,nx:dx/d,ny:dy/d};
}

function collectWalls(
  px:number, py:number, r:number, extra:number,
  grid:Wall[][][], cols:number, rows:number, ox:number, oy:number, cs:number,
): Wall[] {
  const pad=r+extra;
  const c0=Math.max(0,Math.floor((px-pad-ox)/cs));
  const c1=Math.min(cols-1,Math.floor((px+pad-ox)/cs));
  const r0=Math.max(0,Math.floor((py-pad-oy)/cs));
  const r1=Math.min(rows-1,Math.floor((py+pad-oy)/cs));
  const out:Wall[]=[];
  const seen=new Set<string>();
  for(let row=r0;row<=r1;row++) for(let col=c0;col<=c1;col++) {
    for(const w of grid[row][col]) {
      const k=`${w.x}|${w.y}|${w.w}|${w.h}`;
      if(seen.has(k)) continue;
      seen.add(k);
      out.push(w);
    }
  }
  return out;
}

function resolveWalls(px:number,py:number,vx:number,vy:number,r:number,walls:Wall[]) {
  let rx=px,ry=py,rvx=vx,rvy=vy;
  for(let iter=0;iter<10;iter++){
    let hit=false;
    for(const w of walls){
      const h=pushOut(rx,ry,r,w.x,w.y,w.w,w.h);
      if(!h) continue;
      hit=true;
      rx+=h.px; ry+=h.py;
      const dot=rvx*h.nx+rvy*h.ny;
      if(dot<0){rvx-=dot*h.nx;rvy-=dot*h.ny;}
    }
    if(!hit) break;
  }
  return{x:rx,y:ry,vx:rvx,vy:rvy};
}

type WallSeg = { x: number; y: number; w: number; h: number; horiz: boolean };

function buildWallSegments(
  maze: number[][],
  cols: number,
  rows: number,
  cs: number,
  ox: number,
  oy: number,
): WallSeg[] {
  const T = Math.max(2, Math.round(cs * 0.09));
  const segs: WallSeg[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cell = maze[row][col];
      const x = ox + col * cs;
      const y = oy + row * cs;
      if (!(cell & 1)) segs.push({ x, y: y - T, w: cs, h: T, horiz: true });
      if (!(cell & 8)) segs.push({ x: x - T, y, w: T, h: cs, horiz: false });
      if (row === rows - 1 && !(cell & 4)) {
        segs.push({ x, y: y + cs - T, w: cs, h: T, horiz: true });
      }
      if (col === cols - 1 && !(cell & 2)) {
        segs.push({ x: x + cs - T, y, w: T, h: cs, horiz: false });
      }
    }
  }
  return segs;
}

const IMG_BG = require("./assets/images/bg_1.png");
const IMG_FLOOR = require("./assets/images/Floor_1.png");
const IMG_WALL_H = require("./assets/images/wall_h_1.png");
const IMG_WALL_V = require("./assets/images/wall_v_1.png");
const IMG_BALL = require("./assets/images/Ball_1.png");
const IMG_GOAL = require("./assets/images/Goal_1.png");

function TiledShaderRect({
  image,
  x,
  y,
  width,
  height,
}: {
  image: SkImage;
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  const iw = image.width();
  const ih = image.height();
  return (
    <Rect x={x} y={y} width={width} height={height}>
      <ImageShader
        image={image}
        tx="repeat"
        ty="repeat"
        fit="none"
        rect={{ x: 0, y: 0, width: iw, height: ih }}
      />
    </Rect>
  );
}

function GameSkiaScene({
  maze,
  cols,
  rows,
  cs,
  ox,
  oy,
  px,
  py,
  r,
  trailPath,
  cam,
  canvasW,
  canvasH,
  ink,
}: {
  maze: number[][] | null;
  cols: number;
  rows: number;
  cs: number;
  ox: number;
  oy: number;
  px: number;
  py: number;
  r: number;
  trailPath: SkPath;
  cam: { scale: number; tx: number; ty: number };
  canvasW: number;
  canvasH: number;
  ink: string;
}) {
  const imgBg = useImage(IMG_BG);
  const imgFloor = useImage(IMG_FLOOR);
  const imgWallH = useImage(IMG_WALL_H);
  const imgWallV = useImage(IMG_WALL_V);
  const imgBall = useImage(IMG_BALL);
  const imgGoal = useImage(IMG_GOAL);

  const wallSegs = useMemo(
    () => (maze ? buildWallSegments(maze, cols, rows, cs, ox, oy) : []),
    [maze, cols, rows, cs, ox, oy],
  );

  const mazeW = cols * cs;
  const mazeH = rows * cs;
  const goalX = ox + (cols - 1) * cs + cs / 2;
  const goalY = oy + (rows - 1) * cs + cs / 2;
  const goalSize = cs * 0.62;
  const ballSize = r * 2.15;

  const ready =
    imgBg &&
    imgFloor &&
    imgWallH &&
    imgWallV &&
    imgBall &&
    imgGoal;

  if (!ready) return null;

  return (
    <>
      <TiledShaderRect image={imgBg} x={0} y={0} width={canvasW} height={canvasH} />
      <Group
        transform={[
          { translateX: cam.tx },
          { translateY: cam.ty },
          { scale: cam.scale },
        ]}>
        {maze != null && (
          <TiledShaderRect image={imgFloor} x={ox} y={oy} width={mazeW} height={mazeH} />
        )}
        {wallSegs.map((seg, i) => (
          <Image
            key={`w${i}`}
            image={seg.horiz ? imgWallH : imgWallV}
            x={seg.x}
            y={seg.y}
            width={seg.w}
            height={seg.h}
            fit="fill"
          />
        ))}
        <Path
          path={trailPath}
          color={ink}
          style="stroke"
          strokeWidth={2.2}
          strokeCap="round"
          strokeJoin="round"
          opacity={0.82}
        />
        {maze != null && (
          <Image
            image={imgGoal}
            x={goalX - goalSize / 2}
            y={goalY - goalSize / 2}
            width={goalSize}
            height={goalSize}
            fit="contain"
          />
        )}
        {maze != null && (
          <Image
            image={imgBall}
            x={px - ballSize / 2}
            y={py - ballSize / 2}
            width={ballSize}
            height={ballSize}
            fit="contain"
          />
        )}
      </Group>
    </>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function todaySeed() {
  const d=new Date();
  return d.getFullYear()*10000+(d.getMonth()+1)*100+d.getDate();
}
function fmt(s: number) {
  return `${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;
}

const COMPLETED_STORAGE = "daily_maze_completed_v1";

async function loadCompletedMap(): Promise<Record<string, boolean>> {
  try {
    const raw = await AsyncStorage.getItem(COMPLETED_STORAGE);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

async function saveCompleted(key: string) {
  const map = await loadCompletedMap();
  map[key] = true;
  await AsyncStorage.setItem(COMPLETED_STORAGE, JSON.stringify(map));
}

const STREAK_STORAGE = "daily_maze_streak_v1";

function yesterdaySeed() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

async function loadStreak(): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(STREAK_STORAGE);
    if (!raw) return 0;
    const { lastDate, count } = JSON.parse(raw) as { lastDate: number; count: number };
    const today = todaySeed();
    if (lastDate === today || lastDate === yesterdaySeed()) return count;
    return 0;
  } catch {
    return 0;
  }
}

async function recordStreakOnClear(): Promise<number> {
  const today = todaySeed();
  const raw = await AsyncStorage.getItem(STREAK_STORAGE);
  const data = raw
    ? (JSON.parse(raw) as { lastDate: number; count: number })
    : { lastDate: 0, count: 0 };
  if (data.lastDate === today) return data.count;
  data.count = data.lastDate === yesterdaySeed() ? data.count + 1 : 1;
  data.lastDate = today;
  await AsyncStorage.setItem(STREAK_STORAGE, JSON.stringify(data));
  return data.count;
}

type ViewMode = "fit" | "follow";

/** 추적뷰 카메라 lerp 속도 (기준 14의 2배 — 빠르게 수렴, 딱딱하지 않게) */
const FOLLOW_CAM_SPEED = 28;
/** 추적뷰 줌: 터치 없음 30% 줌아웃(0.7), 터치 중 1.0 */
const FOLLOW_ZOOM_OUT = 0.7;
const FOLLOW_ZOOM_IN = 1;
const FOLLOW_ZOOM_LERP_SPEED = 24;

function getCameraTransform(
  g: {
    cols: number;
    rows: number;
    cs: number;
    ox: number;
    oy: number;
    px: number;
    py: number;
    camCx: number;
    camCy: number;
    camFollowZoom: number;
  },
  cw: number,
  ch: number,
  mode: ViewMode,
  zoomMul: number,
) {
  const mw = g.cols * g.cs;
  const mh = g.rows * g.cs;
  const pad = g.cs * 0.5;
  if (mode === "fit") {
    const s =
      Math.min((cw - pad * 2) / (mw + pad), (ch - pad * 2) / (mh + pad)) * zoomMul;
    const cx = g.ox + mw / 2;
    const cy = g.oy + mh / 2;
    return { scale: s, tx: cw / 2 - cx * s, ty: ch / 2 - cy * s };
  }
  const base = Math.max(1.6, Math.min(3.8, (cw * 0.38) / g.cs));
  const scale = base * zoomMul * g.camFollowZoom;
  return {
    scale,
    tx: cw / 2 - g.camCx * scale,
    ty: ch / 2 - g.camCy * scale,
  };
}

/** 캔버스 영역에 미로가 최대한 꽉 차도록 셀 크기·오프셋 계산 */
function calcMazeLayout(cols: number, rows: number, areaW: number, areaH: number) {
  const cs = Math.floor(Math.min(areaW / cols, areaH / rows));
  return {
    cs,
    ox: Math.round((areaW - cols * cs) / 2),
    oy: Math.round((areaH - rows * cs) / 2),
  };
}

type GameState = {
  maze: number[][] | null;
  cols: number;
  rows: number;
  cs: number;
  ox: number;
  oy: number;
  px: number;
  py: number;
  vx: number;
  vy: number;
  r: number;
  grid: Wall[][][] | null;
  trailPath: ReturnType<typeof Skia.Path.Make>;
  trailPts: { x: number; y: number }[];
  camCx: number;
  camCy: number;
  camFollowZoom: number;
};

/** 진행 중인 게임의 미로·공·궤적을 새 캔버스 크기에 맞게 재배치 */
function relayoutGame(g: GameState, areaW: number, areaH: number) {
  if (!g.maze || g.cols < 1 || g.rows < 1) return;
  const { cols, rows, maze } = g;
  const oldCs = g.cs, oldOx = g.ox, oldOy = g.oy;
  const { cs, ox, oy } = calcMazeLayout(cols, rows, areaW, areaH);

  if (oldCs > 0) {
    const relCol = (g.px - oldOx) / oldCs;
    const relRow = (g.py - oldOy) / oldCs;
    const scale = cs / oldCs;
    g.px = ox + relCol * cs;
    g.py = oy + relRow * cs;
    g.camCx = ox + ((g.camCx - oldOx) / oldCs) * cs;
    g.camCy = oy + ((g.camCy - oldOy) / oldCs) * cs;
    g.vx *= scale;
    g.vy *= scale;

    const trail = Skia.Path.Make();
    const pts = g.trailPts;
    if (pts.length > 0) {
      const map = (p: { x: number; y: number }) => ({
        x: ox + ((p.x - oldOx) / oldCs) * cs,
        y: oy + ((p.y - oldOy) / oldCs) * cs,
      });
      const m0 = map(pts[0]);
      trail.moveTo(m0.x, m0.y);
      for (let i = 1; i < pts.length; i++) {
        const m = map(pts[i]);
        trail.lineTo(m.x, m.y);
      }
      g.trailPts = pts.map(map);
    } else {
      trail.moveTo(g.px, g.py);
      g.trailPts = [{ x: g.px, y: g.py }];
    }
    g.trailPath = trail;
  }

  g.cs = cs;
  g.ox = ox;
  g.oy = oy;
  g.r = cs * 0.26;
  g.grid = buildWalls(maze, cols, rows, cs, ox, oy);
}

const DIFF = {
  easy:  {cols:15,rows:20,label:"쉬움",  emoji:"🌱"},
  normal:{cols:20,rows:30,label:"보통",  emoji:"🔥"},
  hard:  {cols:35,rows:52,label:"어려움",emoji:"💀"},
};
type DiffKey = keyof typeof DIFF;
const DIFF_KEYS: DiffKey[] = ["easy", "normal", "hard"];
const MAZES_PER_DIFF = 3;
const MAZE_IDXS = [0, 1, 2] as const;
type MazeIdx = (typeof MAZE_IDXS)[number];
type MazeTarget = { diff: DiffKey; idx: MazeIdx };

function mazeDayKey(d: DiffKey, idx: number, daySeed = todaySeed()) {
  return `${d}_${daySeed}_${idx}`;
}

/** 레거시 호환: diffDayKey(diff, seed) → 슬롯 0 / mazeDayKey(diff, idx, seed) */
function diffDayKey(d: DiffKey, idxOrSeed: number, daySeed?: number) {
  if (daySeed !== undefined) return mazeDayKey(d, idxOrSeed, daySeed);
  return mazeDayKey(d, 0, idxOrSeed);
}

function mazeGenSeed(d: DiffKey, idx: number, daySeed = todaySeed()) {
  return daySeed + d.charCodeAt(0) + idx * 104729;
}

const INKS = ["#1a5ce6","#111111","#c8001a","#0a7a3a"];

const DAILY_QUOTES = [
  "오늘도 길을 찾는 당신, 멋져요!",
  "막다른 길도 결국은 지나갑니다.",
  "천천히 가도 괜찮아요. 도착하면 되니까.",
  "미로는 길이 많고, 인생도 마찬가지예요.",
  "한 번에 안 되면 두 번, 세 번 가면 돼요.",
  "오늘의 당신은 어제보다 한 칸 앞서 있어요.",
  "방향을 잃어도 다시 찾으면 됩니다.",
  "끝까지 가본 사람만이 지도를 그릴 수 있어요.",
  "작은 한 걸음이 큰 탈출을 만듭니다.",
  "오늘의 미로, 내일의 자신감이 됩니다.",
];

function pickDailyQuote(genSeed: number, diff: DiffKey) {
  return DAILY_QUOTES[(genSeed + diff.charCodeAt(0)) % DAILY_QUOTES.length];
}

// ── Win panel (도장 연출) ─────────────────────────────────────────────────────
function WinPanel({
  elapsed,
  diff,
  mazeIdx,
  quote,
  best,
  onMenu,
}: {
  elapsed: number;
  diff: DiffKey;
  mazeIdx: MazeIdx;
  quote: string;
  best: number | undefined;
  onMenu: () => void;
}) {
  const stamp = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    stamp.setValue(0);
    Animated.spring(stamp, {
      toValue: 1,
      friction: 5,
      tension: 88,
      useNativeDriver: true,
    }).start();
  }, [stamp]);

  const stampScale = stamp.interpolate({ inputRange: [0, 1], outputRange: [2.6, 1] });
  const stampOpacity = stamp.interpolate({ inputRange: [0, 0.25, 1], outputRange: [0, 1, 1] });

  return (
    <View style={{ ...S.root, justifyContent: "center" }}>
      <View style={S.winCard}>
        <Animated.View
          style={[
            S.stamp,
            { opacity: stampOpacity, transform: [{ scale: stampScale }, { rotate: "-12deg" }] },
          ]}>
          <Text style={S.stampTxt}>CLEAR</Text>
        </Animated.View>
        <Text style={{ fontSize: 40 }}>🎉</Text>
        <Text style={S.winTitle}>
          {DIFF[diff].emoji} {DIFF[diff].label} · 미로 {mazeIdx + 1}
        </Text>
        <Text style={{ fontSize: 16, fontWeight: "700", color: "#666" }}>탈출 성공!</Text>
        <Text style={S.winTime}>{fmt(elapsed)}</Text>
        {best != null && elapsed <= best + 1 && (
          <Text style={{ color: "#e04", fontWeight: "700" }}>🏅 신기록!</Text>
        )}
        <Text style={S.winQuote}>"{quote}"</Text>
        <Text style={{ fontSize: 12, color: "#888" }}>이 미로는 오늘 클리어 완료!</Text>
        <TouchableOpacity onPress={onMenu} style={S.winMenuBtn}>
          <Text style={{ color: "#fff", fontWeight: "700" }}>메뉴</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

type BootPhase = "loading" | "login" | "nickname" | "ready";

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [boot, setBoot] = useState<BootPhase>("loading");
  const [userId, setUserId] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authErr, setAuthErr] = useState<string | null>(null);
  const [nicknameDraft, setNicknameDraft] = useState("");

  const [screen, setScreen] = useState<"menu"|"game"|"win">("menu");
  const [diff,   setDiff]   = useState<DiffKey>("normal");
  const [mazeIdx, setMazeIdx] = useState<MazeIdx>(0);
  const [inkIdx, setInkIdx] = useState(0);
  const [bests,  setBests]  = useState<Record<string,number>>({});
  const [elapsed,setElapsed]= useState(0);
  const [tick,   setTick]   = useState(0); // force redraw
  const [completedMap, setCompletedMap] = useState<Record<string, boolean>>({});
  const [warnTarget, setWarnTarget] = useState<MazeTarget | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [gameReady, setGameReady] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("follow");
  const [camZoom, setCamZoom] = useState(1);
  const [streak, setStreak] = useState(0);
  const [winQuote, setWinQuote] = useState("");
  const camZoomBaseRef = useRef(1);

  const { width: SW, height: SH } = useWindowDimensions();
  const HUD_H = 76, BAR_H = 64;
  const playAreaRef = useRef({ w: SW, h: Math.max(1, SH - HUD_H - BAR_H) });
  const lastLayoutRef = useRef({ w: 0, h: 0 });
  const pendingInitRef = useRef<MazeTarget | null>(null);
  const [canvasSize, setCanvasSize] = useState(() => ({
    w: SW,
    h: Math.max(1, SH - HUD_H - BAR_H),
  }));

  const timerRef = useRef<ReturnType<typeof setInterval>|null>(null);
  const timerStartRef = useRef<number | null>(null);
  const rafRef   = useRef<number|null>(null);
  const t0Ref    = useRef<number|null>(null);
  const inkRef   = useRef(0);
  const viewModeRef = useRef<ViewMode>("follow");

  const G = useRef({
    maze: null as number[][]|null,
    cols:0, rows:0, cs:0, ox:0, oy:0,
    px:0, py:0, vx:0, vy:0, r:0,
    grid: null as Wall[][][]|null,
    trailPath: Skia.Path.Make(),
    trailPts: [] as {x:number;y:number}[],
    started:false, solved:false, elapsed:0,
    gameReady:false,
    aimActive:false, aimDx:0, aimDy:0,
    diff:"normal" as DiffKey, mazeIdx:0 as MazeIdx, daySeed:0, genSeed:0,
    camCx:0, camCy:0, camFollowZoom:FOLLOW_ZOOM_OUT,
  });

  useEffect(()=>{ inkRef.current=inkIdx; },[inkIdx]);
  useEffect(() => { viewModeRef.current = viewMode; }, [viewMode]);

  const hydrateFromCloud = useCallback(async (uid: string) => {
    const iso = todayIso();
    const seedNum = todaySeed();
    const rows = await fetchTodayResults(uid, iso);
    const completed: Record<string, boolean> = {};
    const best: Record<string, number> = {};
    for (const row of rows) {
      const key = `${row.diff}_${seedNum}_${row.slot}`;
      completed[key] = true;
      if (best[key] == null || row.clear_time < best[key]) best[key] = row.clear_time;
    }
    setCompletedMap(completed);
    setBests((prev) => ({ ...prev, ...best }));
    setStreak(await fetchStreak(uid));
  }, []);

  const continueAfterLogin = useCallback(async () => {
    if (!userId) return;
    setAuthBusy(true);
    setAuthErr(null);
    try {
      const row = await ensureProfileRow(userId);
      if (!row.nickname?.trim()) {
        setProfile(row);
        setNicknameDraft("");
        setBoot("nickname");
        return;
      }
      setProfile(row);
      await hydrateFromCloud(userId);
      setBoot("ready");
    } catch (e) {
      setAuthErr(e instanceof Error ? e.message : "프로필을 불러오지 못했어요.");
      setBoot("login");
    } finally {
      setAuthBusy(false);
    }
  }, [userId, hydrateFromCloud]);

  const resolveSession = useCallback(
    async (uid: string | null) => {
      if (!uid) {
        setUserId(null);
        setUserEmail(null);
        setProfile(null);
        setBoot("login");
        return;
      }
      try {
        setAuthErr(null);
        const { data: { session }, error: sessErr } = await supabase.auth.getSession();
        if (sessErr) throw sessErr;
        if (!session?.user) throw new Error("세션이 없습니다.");

        setUserId(session.user.id);
        setUserEmail(session.user.email ?? null);

        const row = await ensureProfileRow(uid);
        if (!row.nickname?.trim()) {
          setProfile(row);
          setNicknameDraft("");
          setBoot("nickname");
          return;
        }
        setProfile(row);
        await hydrateFromCloud(uid);
        setBoot("ready");
      } catch (e) {
        console.warn("[Auth] resolveSession failed:", e);
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.user) {
          setUserId(session.user.id);
          setUserEmail(session.user.email ?? null);
          setBoot("login");
          setAuthErr(
            e instanceof Error ? e.message : "프로필 연동에 실패했어요. 계속하기를 눌러 다시 시도하세요.",
          );
        } else {
          setUserId(null);
          setUserEmail(null);
          setBoot("login");
          setAuthErr(e instanceof Error ? e.message : "세션 확인에 실패했어요.");
        }
      }
    },
    [hydrateFromCloud],
  );

  const authBootRef = useRef(false);

  useEffect(() => {
    getOAuthRedirectUri();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const { data: { session }, error } = await supabase.auth.getSession();
        if (error) throw error;
        authBootRef.current = true;
        await resolveSession(session?.user?.id ?? null);
      } catch (e) {
        authBootRef.current = true;
        setAuthErr(e instanceof Error ? e.message : "앱 초기화에 실패했어요.");
        setBoot("login");
      }
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (!authBootRef.current && event === "INITIAL_SESSION") return;
      if (event === "TOKEN_REFRESHED") return;
      if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "USER_UPDATED") {
        resolveSession(session?.user?.id ?? null).catch((e) => {
          setAuthErr(e instanceof Error ? e.message : "세션 갱신에 실패했어요.");
          setBoot("login");
        });
      }
    });
    return () => sub.subscription.unsubscribe();
  }, [resolveSession]);

  const oauthHandledByBrowserRef = useRef(false);

  useEffect(() => {
    const onUrl = async ({ url }: { url: string }) => {
      if (oauthHandledByBrowserRef.current) {
        oauthHandledByBrowserRef.current = false;
        return;
      }
      try {
        const handled = await handleOAuthRedirectUrl(url);
        if (!handled) return;
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.user) {
          setUserId(session.user.id);
          setUserEmail(session.user.email ?? null);
          setBoot("login");
          setAuthErr(null);
        }
      } catch (e) {
        setAuthErr(e instanceof Error ? e.message : "OAuth 콜백 처리에 실패했어요.");
        setBoot("login");
      }
    };
    const sub = Linking.addEventListener("url", onUrl);
    Linking.getInitialURL().then((url) => {
      if (url) onUrl({ url });
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (boot !== "ready") return;
    loadCompletedMap().then((local) => {
      setCompletedMap((prev) => ({ ...local, ...prev }));
    });
  }, [boot]);

  const handleGoogleLogin = async () => {
    setAuthBusy(true);
    setAuthErr(null);
    oauthHandledByBrowserRef.current = true;
    try {
      const result = await signInWithGoogle();
      if (!result.ok) {
        if (result.cancelled) return;
        setAuthErr(result.error ?? "로그인에 실패했어요.");
        setBoot("login");
        return;
      }
      setUserId(result.userId);
      setUserEmail(result.email);
      setBoot("login");
      setAuthErr(null);
    } catch (e) {
      setAuthErr(e instanceof Error ? e.message : "로그인에 실패했어요.");
      setBoot("login");
    } finally {
      setAuthBusy(false);
    }
  };

  const handleLogout = async () => {
    setAuthBusy(true);
    try {
      await signOut();
      setScreen("menu");
      await resolveSession(null);
    } catch (e) {
      setAuthErr(e instanceof Error ? e.message : "로그아웃에 실패했어요.");
    } finally {
      setAuthBusy(false);
    }
  };

  const handleSaveNickname = async () => {
    if (!userId || nicknameDraft.trim().length < 2) {
      setAuthErr("닉네임은 2자 이상으로 입력해 주세요.");
      return;
    }
    setAuthBusy(true);
    setAuthErr(null);
    try {
      const p = await saveNickname(userId, nicknameDraft);
      setProfile(p);
      await hydrateFromCloud(userId);
      setBoot("ready");
    } catch (e) {
      setAuthErr(e instanceof Error ? e.message : "저장에 실패했어요.");
    } finally {
      setAuthBusy(false);
    }
  };

  const syncElapsed = useCallback(() => {
    if (timerStartRef.current === null) return 0;
    const e = Math.floor((Date.now() - timerStartRef.current) / 1000);
    G.current.elapsed = e;
    setElapsed(e);
    return e;
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    timerStartRef.current = null;
  }, []);

  const startGameTimer = useCallback(() => {
    stopTimer();
    timerStartRef.current = Date.now();
    G.current.started = true;
    G.current.gameReady = true;
    setGameReady(true);
    setViewMode("follow");
    G.current.camCx = G.current.px;
    G.current.camCy = G.current.py;
    G.current.camFollowZoom = FOLLOW_ZOOM_OUT;
    setCamZoom(1);
    camZoomBaseRef.current = 1;
    syncElapsed();
    timerRef.current = setInterval(syncElapsed, 250);
  }, [stopTimer, syncElapsed]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state: AppStateStatus) => {
      if (state === "active" && screen === "game" && G.current.started) {
        syncElapsed();
      }
    });
    return () => sub.remove();
  }, [screen, syncElapsed]);

  useEffect(() => {
    if (countdown === null) return;
    if (countdown === 0) {
      const t = setTimeout(() => {
        setCountdown(null);
        startGameTimer();
      }, 350);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setCountdown((c) => (c !== null ? c - 1 : null)), 1000);
    return () => clearTimeout(t);
  }, [countdown, startGameTimer]);

  useEffect(() => {
    playAreaRef.current = { w: SW, h: Math.max(1, SH - HUD_H - BAR_H) };
  }, [SW, SH]);

  // ── Init ───────────────────────────────────────────────────────────────────
  const initGame = useCallback((d: DiffKey, idx: MazeIdx, areaW?: number, areaH?: number) => {
    const {cols,rows} = DIFF[d];
    const daySeed = todaySeed();
    const genSeed = mazeGenSeed(d, idx, daySeed);
    const maze = makeMaze(cols, rows, genSeed);
    const aw = areaW ?? playAreaRef.current.w ?? SW;
    const ah = areaH ?? playAreaRef.current.h ?? Math.max(1, SH - HUD_H - BAR_H);
    const {cs, ox, oy} = calcMazeLayout(cols, rows, aw, ah);
    const g    = G.current;
    g.maze=maze; g.cols=cols; g.rows=rows; g.cs=cs; g.ox=ox; g.oy=oy;
    g.r=cs*0.26;
    g.grid=buildWalls(maze,cols,rows,cs,ox,oy);
    g.trailPath=Skia.Path.Make();
    g.px=ox+cs/2; g.py=oy+cs/2;
    g.camCx=g.px; g.camCy=g.py; g.camFollowZoom=FOLLOW_ZOOM_OUT;
    g.vx=0; g.vy=0;
    g.trailPts=[{x:g.px,y:g.py}];
    g.trailPath.moveTo(g.px,g.py);
    g.started=false; g.solved=false; g.elapsed=0;
    g.gameReady=false; g.aimActive=false; g.aimDx=0; g.aimDy=0;
    g.diff=d; g.mazeIdx=idx; g.daySeed=daySeed; g.genSeed=genSeed;
    stopTimer();
    setElapsed(0);
    setGameReady(false);
    setViewMode("follow");
    setCamZoom(1);
    camZoomBaseRef.current = 1;
    lastLayoutRef.current = { w: aw, h: ah };
    setCanvasSize({ w: aw, h: ah });
  },[SW, SH, stopTimer]);

  const resizeGame = useCallback((areaW: number, areaH: number) => {
    const g = G.current;
    if (!g.maze || areaW < 1 || areaH < 1) return;
    relayoutGame(g, areaW, areaH);
    setTick((n) => n + 1);
  }, []);

  const applyPlayAreaSize = useCallback(
    (w: number, h: number, doResize: boolean) => {
      if (w < 1 || h < 1) return;
      const prev = lastLayoutRef.current;
      const changed = Math.abs(prev.w - w) > 0.5 || Math.abs(prev.h - h) > 0.5;
      playAreaRef.current = { w, h };
      lastLayoutRef.current = { w, h };
      setCanvasSize({ w, h });
      if (!doResize || !changed) return;
      resizeGame(w, h);
    },
    [resizeGame],
  );

  useEffect(() => {
    if (screen !== "game" || !pendingInitRef.current) return;
    const t = setTimeout(() => {
      const pending = pendingInitRef.current;
      if (!pending) return;
      pendingInitRef.current = null;
      const { w, h } = playAreaRef.current;
      initGame(pending.diff, pending.idx, w || SW, h || Math.max(1, SH - HUD_H - BAR_H));
    }, 80);
    return () => clearTimeout(t);
  }, [screen, SW, SH, initGame]);

  useEffect(() => {
    if (screen !== "game" || pendingInitRef.current) return;
    if (!G.current.maze) return;
    const { w, h } = playAreaRef.current;
    const areaW = w > 0 ? w : SW;
    const areaH = h > 0 ? h : Math.max(1, SH - HUD_H - BAR_H);
    applyPlayAreaSize(areaW, areaH, true);
  }, [SW, SH, screen, applyPlayAreaSize]);

  const onPlayAreaLayout = useCallback(
    (w: number, h: number) => {
      const pending = pendingInitRef.current;
      if (pending) {
        pendingInitRef.current = null;
        playAreaRef.current = { w, h };
        lastLayoutRef.current = { w, h };
        setCanvasSize({ w, h });
        initGame(pending.diff, pending.idx, w, h);
        return;
      }
      applyPlayAreaSize(w, h, screen === "game" && !!G.current.maze);
    },
    [screen, initGame, applyPlayAreaSize],
  );

  // ── Physics ────────────────────────────────────────────────────────────────
  const physTick = useCallback((dt: number) => {
    const g=G.current;
    if (!g.maze||!g.grid||g.solved||!g.gameReady) return;

    if (viewModeRef.current === "follow") {
      const t = 1 - Math.exp(-FOLLOW_CAM_SPEED * dt);
      g.camCx += (g.px - g.camCx) * t;
      g.camCy += (g.py - g.camCy) * t;
      const zoomTarget = g.aimActive ? FOLLOW_ZOOM_IN : FOLLOW_ZOOM_OUT;
      const tz = 1 - Math.exp(-FOLLOW_ZOOM_LERP_SPEED * dt);
      g.camFollowZoom += (zoomTarget - g.camFollowZoom) * tz;
    }

    const MAX_SPD=g.cs*11;

    if (g.aimActive) {
      const ACCEL=g.cs*42*1.3;
      g.vx+=g.aimDx*ACCEL*dt;
      g.vy+=g.aimDy*ACCEL*dt;
      const sp=Math.hypot(g.vx,g.vy);
      if(sp>MAX_SPD){g.vx=g.vx/sp*MAX_SPD;g.vy=g.vy/sp*MAX_SPD;}
    } else {
      const coast=Math.pow(0.06,dt);
      g.vx*=coast; g.vy*=coast;
      if(Math.hypot(g.vx,g.vy)<g.cs*0.04){g.vx=0;g.vy=0;}
    }

    const move=Math.hypot(g.vx,g.vy)*dt;
    if (move<0.05&&!g.aimActive) {
      setTick((n) => n + 1);
      return;
    }

    const step=Math.min(g.r*0.28, g.cs*0.12);
    const sub=Math.max(1,Math.ceil(move/step));
    const sdt=dt/sub;
    let px=g.px,py=g.py,vx=g.vx,vy=g.vy;
    const {grid,cols,rows,ox,oy,cs,r}=g;

    for(let i=0;i<sub;i++){
      const sx=px, sy=py;
      px+=vx*sdt; py+=vy*sdt;
      const sweep=Math.hypot(px-sx,py-sy)+r*0.5;
      const walls=collectWalls(px,py,r,sweep,grid!,cols,rows,ox,oy,cs);
      const res=resolveWalls(px,py,vx,vy,r,walls);
      px=res.x;py=res.y;vx=res.vx;vy=res.vy;
    }
    g.px=px;g.py=py;g.vx=vx;g.vy=vy;

    // Trail
    g.trailPath.lineTo(px, py);
    g.trailPts.push({ x: px, y: py });

    // Win
    const cx=Math.floor((px-g.ox)/g.cs),cy=Math.floor((py-g.oy)/g.cs);
    if(cx===g.cols-1&&cy===g.rows-1&&!g.solved){
      g.solved=true;
      stopTimer();
      const t=syncElapsed();
      const key=mazeDayKey(g.diff,g.mazeIdx,g.daySeed);
      setBests(prev=>{const u={...prev};if(!u[key]||t<u[key])u[key]=t;return u;});
      setCompletedMap(prev=>({...prev,[key]:true}));
      saveCompleted(key);
      setWinQuote(pickDailyQuote(g.genSeed, g.diff));
      if (userId) {
        saveDailyResult(userId, g.diff, g.mazeIdx, todayIso(), t, g.trailPts)
          .then(() => updateStreakOnClear(userId, todayIso()))
          .then(setStreak)
          .catch(() => recordStreakOnClear().then(setStreak));
      } else {
        recordStreakOnClear().then(setStreak);
      }
      setTimeout(() => setScreen("win"), 450);
    }

    setTick(n=>n+1);
  },[stopTimer, syncElapsed, userId]);

  // ── RAF ────────────────────────────────────────────────────────────────────
  useEffect(()=>{
    if(screen!=="game") return;
    t0Ref.current=null;
    const loop=(ts:number)=>{
      if(t0Ref.current===null) t0Ref.current=ts;
      physTick(Math.min((ts-t0Ref.current)/1000,0.05));
      t0Ref.current=ts;
      rafRef.current=requestAnimationFrame(loop);
    };
    rafRef.current=requestAnimationFrame(loop);
    return()=>{if(rafRef.current)cancelAnimationFrame(rafRef.current);};
  },[screen,physTick]);

  // ── Gesture (조이스틱 + 핀치 줌) ───────────────────────────────────────
  const panGesture = Gesture.Pan()
    .enabled(gameReady)
    .runOnJS(true)
    .onBegin(() => {
      const gc = G.current;
      gc.aimActive = true;
      gc.aimDx = 0;
      gc.aimDy = 0;
    })
    .onUpdate((e) => {
      const gc = G.current;
      const tx = e.translationX;
      const ty = e.translationY;
      const dist = Math.hypot(tx, ty);
      const dead = gc.cs * 0.4;
      if (dist < dead) {
        gc.aimDx = 0;
        gc.aimDy = 0;
        return;
      }
      const t = Math.min(1, (dist - dead) / (gc.cs * 3.2));
      gc.aimDx = (tx / dist) * t;
      gc.aimDy = (ty / dist) * t;
    })
    .onEnd(() => {
      const gc = G.current;
      gc.aimActive = false;
      gc.aimDx = 0;
      gc.aimDy = 0;
    })
    .onFinalize(() => {
      const gc = G.current;
      gc.aimActive = false;
      gc.aimDx = 0;
      gc.aimDy = 0;
    });

  const pinchGesture = Gesture.Pinch()
    .enabled(gameReady)
    .runOnJS(true)
    .onBegin(() => {
      camZoomBaseRef.current = camZoom;
    })
    .onUpdate((e) => {
      const z = Math.min(3.2, Math.max(0.55, camZoomBaseRef.current * e.scale));
      setCamZoom(z);
      setTick((n) => n + 1);
    });

  const gesture = Gesture.Simultaneous(panGesture, pinchGesture);

  const toggleViewMode = () => {
    setViewMode((m) => {
      const next = m === "fit" ? "follow" : "fit";
      if (next === "follow") {
        const gc = G.current;
        gc.camCx = gc.px;
        gc.camCy = gc.py;
        gc.camFollowZoom = gc.aimActive ? FOLLOW_ZOOM_IN : FOLLOW_ZOOM_OUT;
      }
      return next;
    });
    setCamZoom(1);
    camZoomBaseRef.current = 1;
    setTick((n) => n + 1);
  };

  const isLocked=(d:DiffKey,idx:MazeIdx)=>!!completedMap[mazeDayKey(d,idx,seed)];

  const enterGame=({diff:d,idx}:MazeTarget)=>{
    setDiff(d);
    setMazeIdx(idx);
    setWarnTarget(null);
    setViewMode("fit");
    setCamZoom(1);
    camZoomBaseRef.current = 1;
    setCountdown(5);
    pendingInitRef.current={diff:d,idx};
    setScreen("game");
  };

  const requestStart=(d:DiffKey,idx:MazeIdx)=>{
    if(isLocked(d,idx)) return;
    setDiff(d);
    setMazeIdx(idx);
    setWarnTarget({diff:d,idx});
  };

  const cancelWarn=()=>setWarnTarget(null);

  const confirmStart=()=>{
    if(warnTarget) enterGame(warnTarget);
  };

  const seed=todaySeed();
  const g=G.current;
  const ink=INKS[inkIdx];

  if (boot === "loading") {
    return (
      <View style={[S.root, { justifyContent: "center" }]}>
        <StatusBar barStyle="dark-content" />
        <ActivityIndicator size="large" color="#1a5ce6" />
        <Text style={{ marginTop: 12, color: "#888" }}>불러오는 중…</Text>
      </View>
    );
  }

  if (boot === "login") {
    return (
      <View style={[S.root, { justifyContent: "center", gap: 20 }]}>
        <StatusBar barStyle="dark-content" />
        <Text style={S.title}>🗺️ 데일리 미로</Text>
        {userId && userEmail ? (
          <>
            <Text style={{ color: "#2e7d32", textAlign: "center", fontWeight: "800" }}>
              로그인 성공
            </Text>
            <Text style={S.authEmail}>{userEmail}</Text>
            <TouchableOpacity
              style={S.startBtn}
              disabled={authBusy}
              onPress={continueAfterLogin}>
              {authBusy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={{ color: "#fff", fontSize: 18, fontWeight: "800" }}>게임 시작</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={S.signOutBtnPrimary}
              disabled={authBusy}
              onPress={handleLogout}>
              {authBusy ? (
                <ActivityIndicator color="#333" />
              ) : (
                <Text style={S.signOutBtnPrimaryTxt}>로그아웃</Text>
              )}
            </TouchableOpacity>
          </>
        ) : (
          <>
            <Text style={{ color: "#666", textAlign: "center", lineHeight: 22 }}>
              구글 계정으로 로그인하고{"\n"}오늘의 미로 기록을 저장하세요.
            </Text>
            <TouchableOpacity
              style={S.googleBtn}
              disabled={authBusy}
              onPress={handleGoogleLogin}>
              {authBusy ? (
                <ActivityIndicator color="#333" />
              ) : (
                <Text style={S.googleBtnTxt}>Google로 로그인</Text>
              )}
            </TouchableOpacity>
          </>
        )}
        {authErr != null && <Text style={S.authErr}>{authErr}</Text>}
      </View>
    );
  }

  if (boot === "nickname") {
    return (
      <View style={[S.root, { justifyContent: "center", gap: 16 }]}>
        <StatusBar barStyle="dark-content" />
        <Text style={S.title}>닉네임 설정</Text>
        <Text style={{ color: "#666" }}>게임에서 표시될 이름이에요.</Text>
        {profile?.short_id != null && (
          <Text style={{ color: "#1a5ce6", fontWeight: "800" }}>ID #{profile.short_id}</Text>
        )}
        <TextInput
          style={S.nickInput}
          placeholder="닉네임 (2~12자)"
          placeholderTextColor="#aaa"
          maxLength={12}
          value={nicknameDraft}
          onChangeText={setNicknameDraft}
          autoCapitalize="none"
        />
        <TouchableOpacity style={S.startBtn} disabled={authBusy} onPress={handleSaveNickname}>
          {authBusy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={{ color: "#fff", fontSize: 18, fontWeight: "800" }}>시작하기</Text>
          )}
        </TouchableOpacity>
        {authErr != null && <Text style={S.authErr}>{authErr}</Text>}
      </View>
    );
  }

  // ── MENU ───────────────────────────────────────────────────────────────────
  if(screen==="menu") return(
    <View style={S.menuRoot}>
      <StatusBar barStyle="dark-content"/>
      <ScrollView contentContainerStyle={S.menuScroll} showsVerticalScrollIndicator={false}>
        <View style={S.profileBar}>
          <View style={{ flex: 1 }}>
            <Text style={S.profileName}>{profile?.nickname ?? "플레이어"}</Text>
            <Text style={S.profileId}>#{profile?.short_id ?? "------"}</Text>
            {userEmail != null && (
              <Text style={S.profileEmail} numberOfLines={1}>
                {userEmail}
              </Text>
            )}
          </View>
          <View style={S.profileStreakBox}>
            <Text style={S.streakEmoji}>🔥</Text>
            <Text style={S.profileStreakVal}>{streak}</Text>
            <Text style={S.profileStreakLbl}>일 연속</Text>
          </View>
        </View>

        <Text style={S.title}>🗺️ 데일리 미로</Text>
        <Text style={S.date}>
          {new Date().toLocaleDateString("ko-KR",{month:"long",day:"numeric",weekday:"short"})}
        </Text>

        <Text style={S.lbl}>오늘의 미로 (9개)</Text>
        {DIFF_KEYS.map((k) => {
          const v = DIFF[k];
          const cleared = MAZE_IDXS.filter((i) => !!completedMap[mazeDayKey(k, i, seed)]).length;
          return (
            <View key={k} style={S.diffGroup}>
              <View style={S.diffGroupHead}>
                <Text style={S.diffGroupTitle}>{v.emoji} {v.label}</Text>
                <Text style={S.diffGroupMeta}>{v.cols}×{v.rows} · {cleared}/{MAZES_PER_DIFF}</Text>
              </View>
              {MAZE_IDXS.map((idx) => {
                const key = mazeDayKey(k, idx, seed);
                const b = bests[key];
                const locked = isLocked(k, idx);
                const done = !!completedMap[key];
                return (
                  <TouchableOpacity
                    key={key}
                    disabled={locked}
                    onPress={() => requestStart(k, idx)}
                    style={[S.mazeCard, locked && S.mazeCardLocked]}>
                    <View style={S.mazeCardLeft}>
                      <Text style={{ fontSize: 26 }}>{done ? "✅" : locked ? "🔒" : v.emoji}</Text>
                      <View>
                        <Text style={S.mazeCardTitle}>미로 {idx + 1}</Text>
                        <Text style={S.mazeCardSub}>오늘의 {idx + 1}번째</Text>
                      </View>
                    </View>
                    <View style={S.mazeCardRight}>
                      {done && <Text style={S.mazeCardDone}>클리어</Text>}
                      {b != null && <Text style={S.mazeCardBest}>🏅 {fmt(b)}</Text>}
                      {!locked && !done && <Text style={S.mazeCardGo}>도전 →</Text>}
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          );
        })}

        <Text style={S.lbl}>잉크 색</Text>
        <View style={{ flexDirection: "row", gap: 16, marginBottom: 8 }}>
          {INKS.map((c, i) => (
            <TouchableOpacity
              key={i}
              onPress={() => setInkIdx(i)}
              style={{
                width: 32,
                height: 32,
                borderRadius: 16,
                backgroundColor: c,
                borderWidth: inkIdx === i ? 3 : 0,
                borderColor: "#fff",
              }}
            />
          ))}
        </View>
        <Text style={{ color: "#999", fontSize: 12, marginTop: 4 }}>
          드래그 방향으로 공이 움직여요 · 핀치로 확대/축소
        </Text>
        <TouchableOpacity style={S.signOutBtn} disabled={authBusy} onPress={handleLogout}>
          <Text style={S.signOutTxt}>로그아웃</Text>
        </TouchableOpacity>
      </ScrollView>

      <Modal visible={warnTarget!==null} transparent animationType="fade" onRequestClose={cancelWarn}>
        <View style={S.modalBackdrop}>
          <View style={S.modalCard}>
            <Text style={S.modalEmoji}>⚠️</Text>
            <Text style={S.modalTitle}>시작하면 타이머가 멈추지 않아요.</Text>
            <Text style={S.modalBody}>앱을 나가도 시간은 계속 흘러요.{"\n"}준비됐나요?</Text>
            <View style={S.modalBtns}>
              <TouchableOpacity style={S.modalCancel} onPress={cancelWarn}>
                <Text style={S.modalCancelTxt}>취소</Text>
              </TouchableOpacity>
              <TouchableOpacity style={S.modalGo} onPress={confirmStart}>
                <Text style={S.modalGoTxt}>시작!</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );

  // ── WIN ────────────────────────────────────────────────────────────────────
  if (screen === "win") {
    return (
      <WinPanel
        elapsed={elapsed}
        diff={diff}
        quote={winQuote || pickDailyQuote(mazeGenSeed(diff, mazeIdx, seed), diff)}
        best={bests[mazeDayKey(diff, mazeIdx, seed)]}
        mazeIdx={mazeIdx}
        onMenu={() => setScreen("menu")}
      />
    );
  }

  // ── GAME ───────────────────────────────────────────────────────────────────
  const cam =
    g.maze && canvasSize.w > 0
      ? getCameraTransform(g, canvasSize.w, canvasSize.h, viewMode, camZoom)
      : { scale: 1, tx: 0, ty: 0 };

  return(
    <GestureHandlerRootView style={{flex:1,backgroundColor:"#ede8dc"}}>
      <StatusBar barStyle="dark-content"/>

      <View style={[S.hudBar, { height: HUD_H }]}>
        <TouchableOpacity
          style={S.hudBackBtn}
          activeOpacity={0.75}
          onPress={() => {
            stopTimer();
            setCountdown(null);
            setGameReady(false);
            setScreen("menu");
          }}>
          <Text style={S.hudBackTxt}>← 메뉴</Text>
        </TouchableOpacity>
        <View style={S.hudCenter}>
          <Text style={S.hudDiffTxt}>
            {DIFF[diff].emoji} {DIFF[diff].label} #{mazeIdx + 1}
          </Text>
          <Text style={[S.hudTimerTxt, { color: ink }]}>{fmt(elapsed)}</Text>
        </View>
        <TouchableOpacity
          style={S.hudViewBtn}
          activeOpacity={0.75}
          onPress={toggleViewMode}>
          <Text style={S.hudViewTxt}>{viewMode === "fit" ? "🔍 추적" : "🗺️ 전체"}</Text>
        </TouchableOpacity>
      </View>

      <View
        style={{ flex: 1, width: SW, position: "relative", overflow: "hidden" }}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          onPlayAreaLayout(width, height);
        }}>
        <GestureDetector gesture={gesture}>
          <View style={{ width: canvasSize.w, height: canvasSize.h }}>
            <Canvas style={StyleSheet.absoluteFill}>
              <GameSkiaScene
                maze={g.maze}
                cols={g.cols}
                rows={g.rows}
                cs={g.cs}
                ox={g.ox}
                oy={g.oy}
                px={g.px}
                py={g.py}
                r={g.r}
                trailPath={g.trailPath}
                cam={cam}
                canvasW={canvasSize.w}
                canvasH={canvasSize.h}
                ink={ink}
              />
            </Canvas>
          </View>
        </GestureDetector>
        {countdown != null && (
          <View style={S.countdownOverlay} pointerEvents="box-only">
            <BlurView intensity={100} tint="light" style={StyleSheet.absoluteFill} />
            <View style={S.countdownVeil} />
            <View style={S.countdownWrap} pointerEvents="none">
              <Text style={S.countdownNum}>{countdown}</Text>
            </View>
          </View>
        )}
      </View>

      <View style={{height:BAR_H,flexDirection:"row",alignItems:"center",justifyContent:"center",gap:16,backgroundColor:"#ede8dc"}}>
        {INKS.map((c,i)=>(
          <TouchableOpacity key={i} onPress={()=>setInkIdx(i)} style={{
            width:28,height:28,borderRadius:14,backgroundColor:c,
            borderWidth:inkIdx===i?3:0,borderColor:"rgba(255,255,255,0.8)",
          }}/>
        ))}
        <TouchableOpacity
          onPress={()=>{
            const gc=G.current;
            gc.trailPath=Skia.Path.Make();
            gc.trailPts=[{x:gc.px,y:gc.py}];
            gc.trailPath.moveTo(gc.px,gc.py);
            setTick(n=>n+1);
          }}
          style={{marginLeft:8,paddingHorizontal:14,paddingVertical:6,borderRadius:8,backgroundColor:"#ddd"}}>
          <Text style={{fontSize:12,color:"#666"}}>지우기</Text>
        </TouchableOpacity>
      </View>
    </GestureHandlerRootView>
  );
}

const S = StyleSheet.create({
  root:{flex:1,alignItems:"center",justifyContent:"center",backgroundColor:"#fafaf8",gap:16,paddingHorizontal:20},
  menuRoot:{flex:1,backgroundColor:"#fafaf8"},
  menuScroll:{paddingHorizontal:20,paddingBottom:32,gap:12},
  profileBar:{
    flexDirection:"row",
    alignItems:"center",
    gap:12,
    backgroundColor:"#fff",
    paddingVertical:14,
    paddingHorizontal:16,
    borderRadius:16,
    marginTop:8,
    borderWidth:1,
    borderColor:"#e8e8e8",
  },
  profileName:{fontSize:18,fontWeight:"900",color:"#222"},
  profileId:{fontSize:13,fontWeight:"700",color:"#1a5ce6",marginTop:2},
  profileStreakBox:{alignItems:"center",backgroundColor:"#fff3e0",paddingVertical:8,paddingHorizontal:12,borderRadius:12,borderWidth:1,borderColor:"#ffd6a0"},
  profileStreakVal:{fontSize:20,fontWeight:"900",color:"#c45c00"},
  profileStreakLbl:{fontSize:10,fontWeight:"700",color:"#c45c00"},
  streakEmoji:{fontSize:18},
  googleBtn:{width:"100%",paddingVertical:16,borderRadius:14,backgroundColor:"#fff",borderWidth:1,borderColor:"#ddd",alignItems:"center",elevation:2},
  googleBtnTxt:{fontSize:16,fontWeight:"800",color:"#333"},
  authEmail:{fontSize:15,fontWeight:"700",color:"#1a5ce6",textAlign:"center"},
  signOutBtnPrimary:{width:"100%",paddingVertical:14,borderRadius:14,backgroundColor:"#fff",borderWidth:1,borderColor:"#ddd",alignItems:"center"},
  signOutBtnPrimaryTxt:{fontSize:16,fontWeight:"700",color:"#666"},
  authErr:{color:"#c8001a",fontSize:13,textAlign:"center"},
  profileEmail:{fontSize:11,color:"#888",marginTop:4},
  nickInput:{width:"100%",borderWidth:1,borderColor:"#ddd",borderRadius:12,paddingHorizontal:16,paddingVertical:14,fontSize:17,backgroundColor:"#fff"},
  startBtn:{width:"100%",paddingVertical:16,borderRadius:14,backgroundColor:"#1a5ce6",alignItems:"center"},
  signOutBtn:{alignSelf:"center",marginTop:8,paddingVertical:10,paddingHorizontal:20},
  signOutTxt:{fontSize:13,color:"#888",fontWeight:"600"},
  title:{fontSize:28,fontWeight:"900",letterSpacing:-1},
  date:{fontSize:13,color:"#999",marginTop:-8},
  lbl:{fontSize:11,fontWeight:"700",letterSpacing:1.5,color:"#aaa",alignSelf:"flex-start",textTransform:"uppercase"},
  diffGroup:{gap:8,marginBottom:8},
  diffGroupHead:{flexDirection:"row",alignItems:"baseline",justifyContent:"space-between",marginBottom:4,paddingHorizontal:2},
  diffGroupTitle:{fontSize:16,fontWeight:"800",color:"#333"},
  diffGroupMeta:{fontSize:11,color:"#888",fontWeight:"600"},
  mazeCard:{flexDirection:"row",alignItems:"center",justifyContent:"space-between",backgroundColor:"#fff",borderRadius:16,padding:14,borderWidth:1,borderColor:"#e8e8e8"},
  mazeCardLocked:{backgroundColor:"#f0f0f0",opacity:0.85},
  mazeCardLeft:{flexDirection:"row",alignItems:"center",gap:12},
  mazeCardTitle:{fontSize:17,fontWeight:"800"},
  mazeCardSub:{fontSize:12,color:"#888",marginTop:2},
  mazeCardRight:{alignItems:"flex-end",gap:4},
  mazeCardDone:{fontSize:11,fontWeight:"700",color:"#0a7a3a"},
  mazeCardBest:{fontSize:11,fontWeight:"700",color:"#e04"},
  mazeCardGo:{fontSize:13,fontWeight:"700",color:"#1a5ce6"},
  hudBar:{
    flexDirection:"row",
    alignItems:"center",
    justifyContent:"space-between",
    paddingHorizontal:12,
    paddingVertical:8,
    backgroundColor:"#ede8dc",
    gap:10,
  },
  hudBackBtn:{
    backgroundColor:"#fff",
    paddingHorizontal:18,
    paddingVertical:14,
    borderRadius:14,
    minHeight:48,
    minWidth:88,
    justifyContent:"center",
    alignItems:"center",
    borderWidth:1,
    borderColor:"#d4cfc4",
    elevation:2,
  },
  hudBackTxt:{fontSize:16,fontWeight:"800",color:"#444"},
  hudCenter:{flex:1,alignItems:"center",justifyContent:"center",gap:2},
  hudDiffTxt:{fontSize:14,color:"#666",fontWeight:"700"},
  hudTimerTxt:{fontSize:22,fontWeight:"900"},
  hudViewBtn:{
    backgroundColor:"#1a5ce6",
    paddingHorizontal:18,
    paddingVertical:14,
    borderRadius:14,
    minHeight:48,
    minWidth:96,
    justifyContent:"center",
    alignItems:"center",
    elevation:2,
  },
  hudViewTxt:{fontSize:15,fontWeight:"800",color:"#fff"},
  winCard:{backgroundColor:"#fff",borderRadius:24,padding:36,alignItems:"center",gap:10,elevation:8,overflow:"visible"},
  stamp:{position:"absolute",top:18,right:18,width:88,height:88,borderRadius:44,borderWidth:4,borderColor:"#c8001a",backgroundColor:"rgba(200,0,26,0.08)",justifyContent:"center",alignItems:"center",zIndex:2},
  stampTxt:{fontSize:15,fontWeight:"900",color:"#c8001a",letterSpacing:1},
  winTitle:{fontSize:26,fontWeight:"900"},
  winTime:{fontSize:44,fontWeight:"900",color:"#1a5ce6"},
  winQuote:{fontSize:15,color:"#555",textAlign:"center",lineHeight:22,fontStyle:"italic",paddingHorizontal:8,marginTop:4},
  winMenuBtn:{marginTop:8,paddingVertical:14,paddingHorizontal:40,borderRadius:12,backgroundColor:"#1a5ce6"},
  modalBackdrop:{flex:1,backgroundColor:"rgba(0,0,0,0.45)",justifyContent:"center",alignItems:"center",padding:24},
  modalCard:{backgroundColor:"#fff",borderRadius:20,padding:28,width:"100%",maxWidth:340,alignItems:"center",gap:10},
  modalEmoji:{fontSize:40},
  modalTitle:{fontSize:17,fontWeight:"800",textAlign:"center",color:"#222"},
  modalBody:{fontSize:15,color:"#555",textAlign:"center",lineHeight:22},
  modalBtns:{flexDirection:"row",gap:10,marginTop:12,width:"100%"},
  modalCancel:{flex:1,padding:14,borderRadius:12,backgroundColor:"#f0f0f0",alignItems:"center"},
  modalCancelTxt:{fontWeight:"700",color:"#555"},
  modalGo:{flex:1,padding:14,borderRadius:12,backgroundColor:"#1a5ce6",alignItems:"center"},
  modalGoTxt:{fontWeight:"800",color:"#fff"},
  countdownOverlay:{
    ...StyleSheet.absoluteFillObject,
    zIndex:20,
    elevation:20,
  },
  countdownVeil:{
    ...StyleSheet.absoluteFillObject,
    backgroundColor:"rgba(237,232,220,0.88)",
  },
  countdownWrap:{...StyleSheet.absoluteFillObject,justifyContent:"center",alignItems:"center",zIndex:2},
  countdownNum:{fontSize:120,fontWeight:"900",color:"#1a5ce6",textShadowColor:"rgba(255,255,255,0.9)",textShadowOffset:{width:0,height:2},textShadowRadius:8},
});