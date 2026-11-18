import { useEffect, useRef, type RefObject } from "react";

export type ScanMode = "idle" | "search" | "far" | "track" | "match" | "unknown" | "many";
export interface ScanTarget { box: { x: number; y: number; width: number; height: number }; points: { x: number; y: number }[] }

const COLOR: Record<ScanMode, string> = {
  idle: "94,231,255", search: "94,231,255", far: "251,191,36", track: "94,231,255", match: "52,211,153", unknown: "251,191,36", many: "251,191,36",
};
const PINK = "255,79,216";
// Eyes, brows, nose tip, mouth corners, chin — the "+" markers.
const KEY = [36, 39, 42, 45, 19, 24, 30, 48, 54, 8, 33];
const STATUS: Record<ScanMode, string> = {
  idle: "", search: "Поиск лица…", far: "Подойдите ближе", track: "Анализ лица…", match: "Лицо распознано", unknown: "Не узнаю — введите PIN", many: "В кадре несколько человек",
};

/** 68 landmarks + forehead rows above the brows + cheek points, so the mesh covers the whole face. */
function extend(p: { x: number; y: number }[]) {
  if (p.length < 68) return p;
  const h = Math.hypot(p[8].x - p[27].x, p[8].y - p[27].y); // nose bridge → chin
  const out = [...p];
  for (let i = 17; i <= 26; i++) { out.push({ x: p[i].x, y: p[i].y - h * 0.22 }); out.push({ x: p[i].x, y: p[i].y - h * 0.45 }); }
  for (const j of [2, 3, 4, 5, 11, 12, 13, 14]) out.push({ x: (p[j].x * 2 + p[30].x) / 3, y: (p[j].y * 2 + p[30].y) / 3 });
  for (const j of [1, 15]) out.push({ x: (p[j].x + p[j === 1 ? 36 : 45].x) / 2, y: (p[j].y + p[j === 1 ? 36 : 45].y) / 2 });
  return out;
}

/** Edges of a light mesh: every landmark joined to its 3 nearest neighbours (computed once per face shape). */
function meshEdges(pts: { x: number; y: number }[]) {
  const edges = new Set<string>();
  pts.forEach((p, i) => {
    pts.map((q, j) => ({ j, d: (p.x - q.x) ** 2 + (p.y - q.y) ** 2 })).filter((x) => x.j !== i).sort((a, b) => a.d - b.d).slice(0, 4)
      .forEach(({ j }) => edges.add(i < j ? `${i}-${j}` : `${j}-${i}`));
  });
  return [...edges].map((e) => e.split("-").map(Number) as [number, number]);
}

/**
 * Animated face-scanner HUD over a (mirrored, object-cover) video: tracking brackets, scan line,
 * landmark mesh and status. Pure drawing — detection is done by the page.
 */
export default function FaceScanOverlay({ video, target, mode, title = "FACE ID", label, percent, progress }: {
  video: RefObject<HTMLVideoElement | null>; target: ScanTarget | null; mode: ScanMode; title?: string; label?: string | null; percent?: number | null; progress?: number | null;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const state = useRef({ target, mode, cur: null as ScanTarget | null, edges: [] as [number, number][], t0: performance.now() });
  state.current.target = target;
  state.current.mode = mode;

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = canvas.current, v = video.current;
      if (!c || !v) return;
      const dpr = window.devicePixelRatio || 1;
      const cw = c.clientWidth * dpr, ch = c.clientHeight * dpr;
      if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, cw, ch);
      const s = state.current;
      const now = performance.now(), t = (now - s.t0) / 1000;
      const rgb = COLOR[s.mode];
      // video pixels → canvas pixels (object-cover)
      const vw = v.videoWidth || 640, vh = v.videoHeight || 480;
      const k = Math.max(cw / vw, ch / vh), ox = (cw - vw * k) / 2, oy = (ch - vh * k) / 2;
      const map = (p: { x: number; y: number }) => ({ x: ox + p.x * k, y: oy + p.y * k });

      // Smoothly follow the newest detection.
      if (s.target && s.mode !== "search" && s.mode !== "idle") {
        if (!s.cur || s.cur.points.length !== s.target.points.length) { s.cur = structuredClone(s.target); s.edges = meshEdges(extend(s.target.points)); }
        else {
          const a = 0.35;
          s.cur.box = { x: s.cur.box.x + (s.target.box.x - s.cur.box.x) * a, y: s.cur.box.y + (s.target.box.y - s.cur.box.y) * a, width: s.cur.box.width + (s.target.box.width - s.cur.box.width) * a, height: s.cur.box.height + (s.target.box.height - s.cur.box.height) * a };
          s.cur.points = s.cur.points.map((p, i) => ({ x: p.x + (s.target!.points[i].x - p.x) * a, y: p.y + (s.target!.points[i].y - p.y) * a }));
        }
      } else if (s.mode === "search" || s.mode === "idle") s.cur = null;

      // Bracket rectangle: the face (with margin) or a breathing frame in the middle.
      let r: { x: number; y: number; w: number; h: number };
      if (s.cur) {
        const ext = extend(s.cur.points).map(map);
        const xs = ext.map((p) => p.x), ys = ext.map((p) => p.y);
        const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
        const mx = (x1 - x0) * 0.1, my = (y1 - y0) * 0.07;
        r = { x: x0 - mx, y: y0 - my, w: x1 - x0 + 2 * mx, h: y1 - y0 + 2 * my };
      } else {
        const pulse = 1 + Math.sin(t * 2.4) * 0.025;
        const w = Math.min(cw * 0.5, ch * 0.62) * pulse, h = w * 1.25;
        r = { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
      }
      if (s.mode === "idle") return;

      ctx.save();
      ctx.shadowColor = `rgba(${rgb},0.9)`; ctx.shadowBlur = 14 * dpr;
      ctx.strokeStyle = `rgba(${rgb},0.95)`; ctx.lineWidth = 3 * dpr; ctx.lineCap = "round";
      const L = Math.min(r.w, r.h) * 0.2;
      const corner = (x: number, y: number, dx: number, dy: number) => { ctx.beginPath(); ctx.moveTo(x, y + dy * L); ctx.lineTo(x, y); ctx.lineTo(x + dx * L, y); ctx.stroke(); };
      corner(r.x, r.y, 1, 1); corner(r.x + r.w, r.y, -1, 1); corner(r.x, r.y + r.h, 1, -1); corner(r.x + r.w, r.y + r.h, -1, -1);
      ctx.restore();

      // Enrolment progress: an arc filling around the frame.
      if (progress != null) {
        ctx.save(); ctx.strokeStyle = `rgba(${COLOR.match},0.9)`; ctx.lineWidth = 4 * dpr; ctx.shadowColor = `rgba(${COLOR.match},0.8)`; ctx.shadowBlur = 12 * dpr;
        ctx.beginPath(); ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w * 0.56, r.h * 0.56, 0, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress); ctx.stroke(); ctx.restore();
      }

      // Scan line sweeping the frame.
      if (s.mode !== "match") {
        const y = r.y + ((Math.sin(t * 1.8) + 1) / 2) * r.h;
        const g = ctx.createLinearGradient(r.x, 0, r.x + r.w, 0);
        g.addColorStop(0, `rgba(${rgb},0)`); g.addColorStop(0.5, `rgba(${rgb},0.85)`); g.addColorStop(1, `rgba(${rgb},0)`);
        ctx.fillStyle = g; ctx.fillRect(r.x, y - 1 * dpr, r.w, 2 * dpr);
        const glow = ctx.createLinearGradient(0, y - 30 * dpr, 0, y);
        glow.addColorStop(0, `rgba(${rgb},0)`); glow.addColorStop(1, `rgba(${rgb},0.12)`);
        ctx.fillStyle = glow; ctx.fillRect(r.x, y - 30 * dpr, r.w, 30 * dpr);
      }

      // Landmark mesh.
      if (s.cur && s.mode !== "many") {
        const pts = extend(s.cur.points).map(map);
        const shimmer = 0.35 + 0.15 * Math.sin(t * 3);
        ctx.save();
        ctx.shadowColor = `rgba(${rgb},0.8)`; ctx.shadowBlur = 4 * dpr;
        ctx.strokeStyle = `rgba(${rgb},${s.mode === "match" ? 0.6 : shimmer + 0.2})`; ctx.lineWidth = 1.2 * dpr;
        ctx.beginPath();
        for (const [a, b] of s.edges) { ctx.moveTo(pts[a].x, pts[a].y); ctx.lineTo(pts[b].x, pts[b].y); }
        ctx.stroke();
        ctx.fillStyle = `rgba(${rgb},0.9)`;
        for (const p of pts) { ctx.beginPath(); ctx.arc(p.x, p.y, 1.8 * dpr, 0, Math.PI * 2); ctx.fill(); }
        ctx.strokeStyle = `rgba(${PINK},0.95)`; ctx.lineWidth = 2 * dpr; ctx.shadowColor = `rgba(${PINK},0.9)`; ctx.shadowBlur = 8 * dpr;
        const cs = 5 * dpr;
        KEY.forEach((i, n) => {
          const p = pts[i]; if (!p) return;
          const on = s.mode === "match" || (Math.sin(t * 4 + n) > -0.3);
          if (!on) return;
          ctx.beginPath(); ctx.moveTo(p.x - cs, p.y); ctx.lineTo(p.x + cs, p.y); ctx.moveTo(p.x, p.y - cs); ctx.lineTo(p.x, p.y + cs); ctx.stroke();
        });
        ctx.restore();
      }
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [video, progress]);

  const rgb = COLOR[mode];
  return (
    <div className="pointer-events-none absolute inset-0">
      <canvas ref={canvas} className="absolute inset-0 h-full w-full -scale-x-100" />
      {mode !== "idle" && <>
        <div className="absolute left-3 top-3 flex items-center gap-2 rounded-full bg-black/45 px-3 py-1 text-[11px] font-semibold tracking-[0.2em] text-white backdrop-blur">
          <span className="h-2 w-2 animate-pulse rounded-full" style={{ background: `rgb(${rgb})`, boxShadow: `0 0 8px rgb(${rgb})` }} />{title}
        </div>
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-4 pb-2.5 pt-6 text-center text-white">
          {label && <div className="text-lg font-semibold drop-shadow">{label}</div>}
          <div className="text-sm" style={{ color: `rgb(${rgb})` }}>{STATUS[mode]}</div>
          {percent != null && (
            <div className="mx-auto mt-1.5 flex max-w-[220px] items-center gap-2 text-xs">
              <div className="h-1.5 flex-1 overflow-hidden rounded bg-white/20"><div className="h-full rounded transition-all duration-700" style={{ width: `${percent}%`, background: `rgb(${rgb})`, boxShadow: `0 0 8px rgb(${rgb})` }} /></div>
              <span className="tabular-nums">{percent}%</span>
            </div>
          )}
        </div>
      </>}
    </div>
  );
}
