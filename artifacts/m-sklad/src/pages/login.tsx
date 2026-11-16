import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BRAND_NAME } from "@/hooks/useAuthState";

function errorText(err: unknown, fallback: string): string {
  return (err as { data?: { error?: string } } | null)?.data?.error ?? fallback;
}

function AuthCard({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-primary px-4">
      <div className="w-full max-w-sm rounded-2xl border bg-card text-card-foreground p-8 shadow-xl">
        <div className="flex flex-col items-center text-center mb-6">
          <img src={`${import.meta.env.BASE_URL}brand/logo-horizontal.svg`} alt={BRAND_NAME} className="h-16 w-auto mb-5" />
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Sign in with login + password (local server, works without internet). */
export function LoginPage() {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await customFetch("/api/auth/login", { method: "POST", body: JSON.stringify({ login, password }) });
      await queryClient.resetQueries({ queryKey: ["/api/auth/me"] });
      setLocation("/dashboard");
    } catch (err) {
      setError(errorText(err, "Не удалось войти"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Вход в систему" subtitle="Система управления рестораном">
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="login">Логин</Label>
          <Input id="login" autoComplete="username" autoCapitalize="none" value={login} onChange={(e) => setLogin(e.target.value)} autoFocus />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">Пароль</Label>
          <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        <Button type="submit" className="w-full" disabled={busy || !login || !password}>{busy ? "Вход…" : "Войти"}</Button>
        <p className="text-xs text-center text-muted-foreground">Забыли пароль? Обратитесь к администратору.</p>
      </form>
    </AuthCard>
  );
}

/** First launch: no accounts exist yet — create the administrator. */
export function SetupPage() {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const [form, setForm] = useState({ firstName: "", lastName: "", login: "", password: "", confirm: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (form.password !== form.confirm) { setError("Пароли не совпадают"); return; }
    setBusy(true);
    try {
      const { confirm: _c, ...body } = form;
      await customFetch("/api/auth/setup", { method: "POST", body: JSON.stringify(body) });
      await queryClient.resetQueries({ queryKey: ["/api/auth/me"] });
      await queryClient.resetQueries({ queryKey: ["/api/auth/status"] });
      setLocation("/dashboard");
    } catch (err) {
      setError(errorText(err, "Не удалось создать администратора"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title={`Добро пожаловать в ${BRAND_NAME}`} subtitle="Первый запуск: создайте учётную запись администратора">
      <form onSubmit={onSubmit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5"><Label htmlFor="fn">Имя</Label><Input id="fn" value={form.firstName} onChange={set("firstName")} autoFocus /></div>
          <div className="space-y-1.5"><Label htmlFor="ln">Фамилия</Label><Input id="ln" value={form.lastName} onChange={set("lastName")} /></div>
        </div>
        <div className="space-y-1.5"><Label htmlFor="sl">Логин</Label><Input id="sl" autoComplete="username" autoCapitalize="none" value={form.login} onChange={set("login")} placeholder="например, admin" /></div>
        <div className="space-y-1.5"><Label htmlFor="sp">Пароль</Label><Input id="sp" type="password" autoComplete="new-password" value={form.password} onChange={set("password")} placeholder="Минимум 8 символов" /></div>
        <div className="space-y-1.5"><Label htmlFor="sc">Повторите пароль</Label><Input id="sc" type="password" autoComplete="new-password" value={form.confirm} onChange={set("confirm")} /></div>
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        <Button type="submit" className="w-full" disabled={busy || !form.login || !form.password}>{busy ? "Создание…" : "Создать и войти"}</Button>
      </form>
    </AuthCard>
  );
}
