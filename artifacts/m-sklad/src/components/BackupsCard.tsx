import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckCircle2, AlertTriangle, HardDrive } from "lucide-react";
import { fmtDayTime } from "@/lib/personnel";

interface Status { configured: boolean; lastBackupAt?: string | null; ageHours?: number | null; ok?: boolean; error?: string; totalSize?: number; files?: { name: string; kind: string; size: number; at: string }[] }
const mb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} ГБ` : `${(b / 1e6).toFixed(1)} МБ`);

export default function BackupsCard() {
  const { data } = useQuery<Status>({ queryKey: ["/api/admin/backups"], queryFn: () => customFetch("/api/admin/backups") });
  if (!data) return null;
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2 text-base"><HardDrive className="h-5 w-5" />Резервные копии</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!data.configured ? (
          <p className="text-muted-foreground">Резервное копирование ещё не настроено на этом сервере. При установке в ресторане оно включается автоматически (сервис backup в docker-compose): каждую ночь в 4:00 сохраняется база и файлы, хранятся последние 14 дней.</p>
        ) : <>
          <div className={`flex items-start gap-2 rounded-lg border p-3 ${data.ok ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-red-200 bg-red-50 text-red-900"}`}>
            {data.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4" /> : <AlertTriangle className="mt-0.5 h-4 w-4" />}
            <div>{data.error ?? (data.lastBackupAt ? <>Последняя копия: <b>{fmtDayTime(data.lastBackupAt)}</b> ({data.ageHours} ч назад){data.ok ? "" : " — копии перестали делаться, проверьте сервер"}</> : "Копий ещё нет — первая появится в течение часа после запуска")}</div>
          </div>
          {!!data.files?.length && <>
            <div className="text-muted-foreground">Всего копий: {data.files.length} · {mb(data.totalSize ?? 0)}</div>
            <div className="max-h-56 overflow-y-auto rounded border">
              {data.files.map((f) => <div key={f.name} className="flex justify-between gap-2 border-b px-3 py-1.5 last:border-0"><span>{f.kind === "db" ? "База данных" : "Файлы (фото, чеки)"} · {fmtDayTime(f.at)}</span><span className="tabular-nums text-muted-foreground">{mb(f.size)}</span></div>)}
            </div>
          </>}
          <p className="text-xs text-muted-foreground">Копии лежат в папке backups на сервере ресторана. Раз в неделю копируйте их на флешку или в облако — на случай поломки самого сервера. Как восстановить — в docs/BACKUP.md.</p>
        </>}
      </CardContent>
    </Card>
  );
}
