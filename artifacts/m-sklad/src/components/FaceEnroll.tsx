import { useEffect, useRef, useState } from "react";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Loader2, ScanFace, CheckCircle2 } from "lucide-react";
import { scanFace, loadFaceApi } from "@/lib/face";
import FaceScanOverlay, { type ScanMode, type ScanTarget } from "@/components/FaceScanOverlay";

const NEED = 5;

/** Camera → five face samples (the person turns the head slightly) → saved on the staff card. */
export default function FaceEnroll({ staffId, name, onDone }: { staffId: number; name: string; onDone: (ok: boolean) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "capturing" | "saving" | "done" | "error">("loading");
  const [hint, setHint] = useState("Загружаем распознавание…");
  const [samples, setSamples] = useState<number[][]>([]);
  const [error, setError] = useState<string | null>(null);
  const [scan, setScan] = useState<{ mode: ScanMode; target: ScanTarget | null }>({ mode: "search", target: null });

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stop = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
        if (stop) return;
        if (video.current) { video.current.srcObject = stream; await video.current.play(); }
        await loadFaceApi();
        if (!stop) { setState("ready"); setHint("Встаньте перед камерой и нажмите «Начать»"); }
      } catch (e) { setState("error"); setError(e instanceof DOMException ? "Нет доступа к камере (нужен https или localhost)" : "Не удалось загрузить распознавание лица"); }
    })();
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, []);

  useEffect(() => {
    if (state !== "capturing") return;
    let alive = true;
    const got: number[][] = [];
    (async () => {
      const prompts = ["Смотрите прямо в камеру", "Чуть поверните голову влево", "Чуть поверните голову вправо", "Слегка поднимите подбородок", "Снова прямо"];
      while (alive && got.length < NEED) {
        setHint(prompts[got.length]);
        const r = video.current ? await scanFace(video.current, 0.22) : null;
        if (!alive) return;
        if (r === "many") { setHint("В кадре должен быть только один человек"); setScan((x) => ({ mode: "many", target: x.target })); }
        else if (r && r.close) { got.push(r.shot.descriptor); setSamples([...got]); setScan({ mode: "track", target: r.shot }); await new Promise((res) => setTimeout(res, 700)); continue; }
        else if (r) { setHint("Подойдите ближе к камере"); setScan({ mode: "far", target: r.shot }); }
        else setScan({ mode: "search", target: null });
        await new Promise((res) => setTimeout(res, 120));
      }
      if (!alive) return;
      setState("saving"); setHint("Сохраняем…");
      try {
        await customFetch(`/api/personnel/staff/${staffId}/faces`, { method: "PUT", body: JSON.stringify({ descriptors: got }) });
        setState("done"); setHint("Готово — теперь киоск узнаёт сотрудника"); setScan((x) => ({ mode: "match", target: x.target }));
      } catch (e) {
        setState("error"); setError((e as { data?: { error?: string } })?.data?.error ?? "Не сохранилось");
      }
    })();
    return () => { alive = false; };
  }, [state, staffId]);

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">Регистрация лица: <b>{name}</b>. Сохраняются только числовые признаки лица для распознавания в киоске — без фотографий.</p>
      <div className="relative mx-auto aspect-[4/3] w-full max-w-md overflow-hidden rounded-xl bg-black">
        <video ref={video} muted playsInline className="h-full w-full -scale-x-100 object-cover" />
        {state !== "loading" && <FaceScanOverlay video={video} mode={state === "ready" ? "search" : state === "error" ? "unknown" : scan.mode} target={scan.target} title="FACE ID · РЕГИСТРАЦИЯ"
          label={state === "done" ? name : null} progress={state === "capturing" || state === "saving" || state === "done" ? samples.length / NEED : null} />}
        {state === "loading" && <div className="absolute inset-0 flex items-center justify-center text-white"><Loader2 className="h-8 w-8 animate-spin" /></div>}
      </div>
      <div className="flex gap-1">{Array.from({ length: NEED }, (_, i) => <div key={i} className={`h-2 flex-1 rounded ${i < samples.length ? "bg-emerald-500" : "bg-muted"}`} />)}</div>
      <div className={`text-center font-medium ${state === "error" ? "text-red-700" : state === "done" ? "text-emerald-700" : ""}`}>{state === "error" ? error : hint}</div>
      <div className="flex justify-end gap-2">
        {state === "done" ? <Button onClick={() => onDone(true)}><CheckCircle2 className="mr-1.5 h-4 w-4" />Закрыть</Button> : <>
          <Button variant="outline" onClick={() => onDone(false)}>Отмена</Button>
          {(state === "ready" || state === "error") && <Button onClick={() => { setSamples([]); setError(null); setState("capturing"); }} disabled={state === "error" && !error?.includes("разных") && !error?.includes("уже")}><ScanFace className="mr-1.5 h-4 w-4" />{state === "error" ? "Повторить" : "Начать"}</Button>}
        </>}
      </div>
    </div>
  );
}
