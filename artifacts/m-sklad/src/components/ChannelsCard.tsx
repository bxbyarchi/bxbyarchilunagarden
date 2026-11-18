import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Circle, Copy, Instagram, MessageCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { fmtDayTime } from "@/lib/personnel";

interface Status { webhookUrl: string; httpsOk: boolean; verifyTokenSet: boolean; appSecretSet: boolean; whatsapp: { ready: boolean; lastMessageAt: string | null }; instagram: { ready: boolean; lastMessageAt: string | null } }

function Row({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return <div className="flex items-start gap-2">{ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}<div>{children}</div></div>;
}

/** What is still missing to receive WhatsApp / Instagram messages, and the webhook address for Meta. */
export default function ChannelsCard() {
  const { toast } = useToast();
  const { data: s } = useQuery<Status>({ queryKey: ["/api/channels/status"], queryFn: () => customFetch("/api/channels/status") });
  if (!s) return null;
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base">Каналы: WhatsApp и Instagram</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className={`rounded-lg border p-3 ${s.whatsapp.ready ? "border-emerald-200 bg-emerald-50/50" : ""}`}>
            <div className="flex items-center gap-2 font-medium"><MessageCircle className="h-4 w-4" />WhatsApp {s.whatsapp.ready ? "подключён" : "не подключён"}</div>
            <div className="mt-1 text-xs text-muted-foreground">{s.whatsapp.lastMessageAt ? `последнее сообщение ${fmtDayTime(s.whatsapp.lastMessageAt)}` : s.whatsapp.ready ? "сообщений ещё не было" : "нужны WHATSAPP_TOKEN и WHATSAPP_PHONE_NUMBER_ID"}</div>
          </div>
          <div className={`rounded-lg border p-3 ${s.instagram.ready ? "border-emerald-200 bg-emerald-50/50" : ""}`}>
            <div className="flex items-center gap-2 font-medium"><Instagram className="h-4 w-4" />Instagram {s.instagram.ready ? "подключён" : "не подключён"}</div>
            <div className="mt-1 text-xs text-muted-foreground">{s.instagram.lastMessageAt ? `последнее сообщение ${fmtDayTime(s.instagram.lastMessageAt)}` : s.instagram.ready ? "сообщений ещё не было" : "нужны INSTAGRAM_TOKEN и INSTAGRAM_ACCOUNT_ID"}</div>
          </div>
        </div>
        <div className="space-y-1.5">
          <Row ok={s.httpsOk}>Сервер доступен по https (Meta принимает только https)</Row>
          <Row ok={s.appSecretSet}>META_APP_SECRET — проверка, что сообщения пришли от Meta</Row>
          <Row ok={s.verifyTokenSet}>META_VERIFY_TOKEN — тот же текст вводится в Meta при подключении вебхука</Row>
        </div>
        <div className="rounded-lg bg-muted/50 p-3">
          <div className="text-xs text-muted-foreground">Адрес вебхука для Meta (Callback URL):</div>
          <div className="mt-1 flex items-center gap-2"><code className="flex-1 break-all text-xs">{s.webhookUrl}</code>
            <Button size="sm" variant="outline" onClick={() => { void navigator.clipboard?.writeText(s.webhookUrl); toast({ title: "Скопировано" }); }}><Copy className="mr-1 h-3.5 w-3.5" />Копировать</Button></div>
        </div>
        <p className="text-xs text-muted-foreground">Пошаговая инструкция подключения — docs/META.md. С гостями в этих каналах всегда отвечает сильная модель Claude.</p>
      </CardContent>
    </Card>
  );
}
