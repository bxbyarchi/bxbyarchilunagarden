import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { customFetch } from "@workspace/api-client-react";
import { Delete, LogIn, LogOut, CameraOff, ArrowLeft, AlertTriangle, ScanFace, UserCheck } from "lucide-react";
import { scanFace, loadFaceApi } from "@/lib/face";
import FaceScanOverlay, { type ScanMode, type ScanTarget } from "@/components/FaceScanOverlay";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import AccessDenied from "@/components/AccessDenied";
import { PERSONNEL_ADMIN, errMsg, fmtMin, fmtTime } from "@/lib/personnel";

type Result =
  | { action: "in"; staffName: string; at: string; plan: { startTime: string; endTime: string } | null; lateMin: number }
  | { action: "out"; staffName: string; at: string; since: string; workedMin: number; overtimeMin: number; earlyMin: number }
  | { action: "confirm"; staffName: string; message: string };

const TZ = "Asia/Bishkek";

export default function Kiosk() {
  const { user, isLoading } = useCurrentUser();
  const video = useRef<HTMLVideoElement>(null);
  const [camera, setCamera] = useState<"wait" | "on" | "off">("wait");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(new Date());
  // Face recognition: on when at least one employee has a registered face.
  const [faceMode, setFaceMode] = useState<"off" | "loading" | "on">("off");
  const [faceMatch, setFaceMatch] = useState<{ staffName: string; action: "in" | "out"; descriptor: number[]; percent: number | null } | null>(null);
  const [scan, setScan] = useState<{ mode: ScanMode; target: ScanTarget | null }>({ mode: "search", target: null });
  const faceAuth = useRef<number[] | null>(null);
  const cooldown = useRef(0);

  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => {
    let stream: MediaStream | null = null;
    if (!navigator.mediaDevices?.getUserMedia) { setCamera("off"); return; }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false })
      .then((s) => { stream = s; if (video.current) { video.current.srcObject = s; void video.current.play(); } setCamera("on"); })
      .catch(() => setCamera("off"));
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, []);
  useEffect(() => {
    if (camera !== "on") return;
    let alive = true;
    customFetch<{ staff: number }>("/api/personnel/kiosk/faces-enabled").then(async (r) => {
      if (!r.staff || !alive) return;
      setFaceMode("loading");
      try { await loadFaceApi(); if (alive) setFaceMode("on"); } catch { if (alive) setFaceMode("off"); }
    }).catch(() => {});
    return () => { alive = false; };
  }, [camera]);
  // Scan continuously while idle: the overlay follows the face; once it is close and clear we ask
  // the server who it is, and the person confirms "it's me".
  useEffect(() => {
    if (faceMode !== "on" || result || error || faceMatch || busy || pin) return;
    let alive = true;
    let asking = false;
    (async () => {
      while (alive) {
        await new Promise((r) => setTimeout(r, 90));
        if (!alive || !video.current) continue;
        let r;
        try { r = await scanFace(video.current); } catch { continue; }
        if (!alive) return;
        if (r === null) { setScan({ mode: "search", target: null }); continue; }
        if (r === "many") { setScan((x) => ({ mode: "many", target: x.target })); continue; }
        const { shot, close } = r;
        const cooling = Date.now() < cooldown.current;
        setScan({ mode: !close ? "far" : cooling ? "unknown" : "track", target: shot });
        if (!close || cooling || asking) continue;
        asking = true;
        try {
          const res = await customFetch<{ found: boolean; reason?: string; staffName?: string; action?: "in" | "out"; percent?: number }>("/api/personnel/kiosk/identify", { method: "POST", body: JSON.stringify({ descriptor: shot.descriptor }) });
          if (!alive) return;
          if (res.found) { setScan({ mode: "match", target: shot }); setFaceMatch({ staffName: res.staffName!, action: res.action!, descriptor: shot.descriptor, percent: res.percent ?? null }); return; }
          cooldown.current = Date.now() + 3000;
          setScan({ mode: "unknown", target: shot });
        } catch { cooldown.current = Date.now() + 3000; }
        finally { asking = false; }
      }
    })();
    return () => { alive = false; };
  }, [faceMode, result, error, faceMatch, busy, pin]);
  useEffect(() => {
    if (!faceMatch) return;
    const t = setTimeout(() => { setFaceMatch(null); cooldown.current = Date.now() + 2000; }, 8000);
    return () => clearTimeout(t);
  }, [faceMatch]);

  // Result and error screens clear themselves so the next person can check in.
  useEffect(() => {
    if (!result && !error) return;
    const t = setTimeout(() => { setResult(null); setError(null); setPin(""); }, result?.action === "confirm" ? 10_000 : 5_000);
    return () => clearTimeout(t);
  }, [result, error]);

  const snapshot = useCallback((): string | null => {
    const v = video.current;
    if (camera !== "on" || !v || !v.videoWidth) return null;
    const w = 480, h = Math.round((v.videoHeight / v.videoWidth) * w);
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const ctx = c.getContext("2d"); if (!ctx) return null;
    ctx.translate(w, 0); ctx.scale(-1, 1); // the preview is mirrored; keep the photo as people saw themselves
    ctx.drawImage(v, 0, 0, w, h);
    return c.toDataURL("image/jpeg", 0.75);
  }, [camera]);

  async function submit(confirm = false, descriptor: number[] | null = confirm ? faceAuth.current : null) {
    if ((!descriptor && pin.length < 4) || busy) return;
    setBusy(true); setError(null); setFaceMatch(null);
    faceAuth.current = descriptor;
    try {
      const r = await customFetch<Result>("/api/personnel/kiosk", { method: "POST", body: JSON.stringify(descriptor ? { descriptor, photo: snapshot(), confirm } : { pin, photo: snapshot(), confirm }) });
      setResult(r);
      if (r.action !== "confirm") { setPin(""); faceAuth.current = null; }
    } catch (e) { setError(errMsg(e) ?? "Нет связи с сервером"); setPin(""); faceAuth.current = null; } finally { setBusy(false); cooldown.current = Date.now() + 4000; }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (result || error) return;
      if (/^\d$/.test(e.key)) setPin((p) => (p.length < 6 ? p + e.key : p));
      else if (e.key === "Backspace") setPin((p) => p.slice(0, -1));
      else if (e.key === "Enter") void submit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (isLoading) return null;
  if (![...PERSONNEL_ADMIN, "cashier"].includes(user?.role ?? "")) return <AccessDenied />;

  const key = (d: string) => (
    <button key={d} type="button" onClick={() => setPin((p) => (p.length < 6 ? p + d : p))} className="h-16 rounded-2xl bg-white/10 text-2xl font-semibold text-white transition active:scale-95 active:bg-white/25 sm:h-20">{d}</button>
  );

  return (
    <div className="flex min-h-[100dvh] flex-col bg-sidebar text-sidebar-foreground">
      <header className="flex items-center justify-between px-5 py-4">
        <img src={`${import.meta.env.BASE_URL}brand/logo-horizontal-white.svg`} alt="Luna Garden" className="h-10 w-auto" />
        <div className="text-right">
          <div className="text-3xl font-semibold tabular-nums">{now.toLocaleTimeString("ru-RU", { timeZone: TZ, hour: "2-digit", minute: "2-digit" })}</div>
          <div className="text-sm text-sidebar-foreground/60">{now.toLocaleDateString("ru-RU", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" })}</div>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-5xl flex-1 items-center gap-6 px-5 pb-6 md:grid-cols-2">
        <div className="relative mx-auto aspect-[4/3] w-full max-w-md overflow-hidden rounded-3xl bg-black/30">
          <video ref={video} muted playsInline className={`h-full w-full -scale-x-100 object-cover ${camera === "on" ? "" : "hidden"}`} />
          {camera !== "on" && <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-sidebar-foreground/70">
            <CameraOff className="h-8 w-8" />{camera === "wait" ? "Включаем камеру…" : "Камера недоступна — отметка без фото. Разрешите камеру в браузере (нужен адрес https или localhost)."}
          </div>}
          {camera === "on" && faceMode === "on" && <FaceScanOverlay video={video} mode={result ? "idle" : faceMatch ? "match" : scan.mode} target={scan.target}
            label={faceMatch?.staffName ?? null} percent={faceMatch?.percent ?? null} title="FACE ID · LUNA GARDEN" />}
          {camera === "on" && faceMode !== "on" && <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 p-3 text-center text-sm text-white">
            {faceMode === "loading" ? <span className="inline-flex items-center gap-1.5"><ScanFace className="h-4 w-4 animate-pulse" />Включаем распознавание лица…</span> : "Смотрите в камеру — фото сделается при вводе PIN"}</div>}
        </div>

        <div className="mx-auto w-full max-w-sm">
          {faceMatch && !result ? (
            <div className="rounded-3xl bg-white p-6 text-center text-foreground shadow-xl">
              <UserCheck className="mx-auto h-12 w-12 text-primary" />
              <div className="mt-3 text-2xl font-semibold">{faceMatch.staffName}</div>
              <p className="mt-1 text-lg">{faceMatch.action === "in" ? "Отметить приход?" : "Отметить уход?"}</p>
              <div className="mt-5 grid grid-cols-2 gap-2">
                <button type="button" className="h-14 rounded-xl border text-lg font-medium" onClick={() => { setFaceMatch(null); cooldown.current = Date.now() + 5000; setScan({ mode: "unknown", target: null }); }}>Это не я</button>
                <button type="button" disabled={busy} className="h-14 rounded-xl bg-primary text-lg font-medium text-primary-foreground" onClick={() => submit(false, faceMatch.descriptor)}>Да, это я</button>
              </div>
            </div>
          ) : result ? (
            <div className="rounded-3xl bg-white p-6 text-center text-foreground shadow-xl">
              {result.action === "confirm" ? <>
                <AlertTriangle className="mx-auto h-12 w-12 text-amber-500" />
                <div className="mt-3 text-xl font-semibold">{result.staffName}</div>
                <p className="mt-1 text-muted-foreground">{result.message}</p>
                <div className="mt-5 grid grid-cols-2 gap-2">
                  <button type="button" className="h-12 rounded-xl border font-medium" onClick={() => { setResult(null); setPin(""); }}>Нет</button>
                  <button type="button" className="h-12 rounded-xl bg-primary font-medium text-primary-foreground" onClick={() => submit(true)}>Да, ухожу</button>
                </div>
              </> : result.action === "in" ? <>
                <LogIn className="mx-auto h-12 w-12 text-emerald-600" />
                <div className="mt-3 text-2xl font-semibold">Добро пожаловать, {result.staffName.split(" ")[0]}!</div>
                <p className="mt-1 text-lg">Приход: <b>{fmtTime(result.at)}</b></p>
                {result.plan && <p className="text-muted-foreground">Смена по графику {result.plan.startTime}–{result.plan.endTime}</p>}
                {!result.plan && <p className="text-muted-foreground">Сегодня по графику смены нет — отметка сохранена</p>}
                {result.lateMin > 0 && <p className="mt-2 rounded-lg bg-amber-50 px-3 py-1.5 text-amber-800">Опоздание {fmtMin(result.lateMin)}</p>}
              </> : <>
                <LogOut className="mx-auto h-12 w-12 text-sky-600" />
                <div className="mt-3 text-2xl font-semibold">До свидания, {result.staffName.split(" ")[0]}!</div>
                <p className="mt-1 text-lg">Уход: <b>{fmtTime(result.at)}</b></p>
                <p className="text-muted-foreground">Отработано {fmtMin(result.workedMin)} (с {fmtTime(result.since)})</p>
                {result.overtimeMin > 0 && <p className="mt-2 rounded-lg bg-sky-50 px-3 py-1.5 text-sky-800">Переработка {fmtMin(result.overtimeMin)}</p>}
                {result.earlyMin > 15 && <p className="mt-2 rounded-lg bg-amber-50 px-3 py-1.5 text-amber-800">Раньше конца смены на {fmtMin(result.earlyMin)}</p>}
              </>}
            </div>
          ) : (
            <>
              <div className="mb-1 text-center text-lg font-medium">Введите свой PIN</div>
              <div className="mb-4 flex h-14 items-center justify-center gap-3">
                {Array.from({ length: Math.max(4, pin.length) }, (_, i) => <span key={i} className={`h-4 w-4 rounded-full ${i < pin.length ? "bg-white" : "bg-white/20"}`} />)}
              </div>
              {error && <div className="mb-3 rounded-xl bg-red-500/90 px-3 py-2 text-center font-medium text-white">{error}</div>}
              <div className="grid grid-cols-3 gap-2.5">
                {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map(key)}
                <button type="button" aria-label="Стереть" onClick={() => setPin((p) => p.slice(0, -1))} className="flex h-16 items-center justify-center rounded-2xl text-white/70 active:bg-white/10 sm:h-20"><Delete className="h-7 w-7" /></button>
                {key("0")}
                <button type="button" disabled={pin.length < 4 || busy} onClick={() => submit()} className="h-16 rounded-2xl bg-white text-lg font-semibold text-sidebar disabled:opacity-40 sm:h-20">{busy ? "…" : "OK"}</button>
              </div>
              <p className="mt-4 text-center text-sm text-sidebar-foreground/60">Один и тот же PIN: пришли — отметка прихода, уходите — отметка ухода.</p>
            </>
          )}
        </div>
      </main>
      <footer className="px-5 pb-4"><Link href="/timesheet" className="inline-flex items-center gap-1 text-xs text-sidebar-foreground/40 hover:text-sidebar-foreground/80"><ArrowLeft className="h-3 w-3" />Выйти из киоска</Link></footer>
    </div>
  );
}
