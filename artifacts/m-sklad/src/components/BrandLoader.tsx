import { useEffect } from "react";

/**
 * The same moon-and-logo screen as the HTML splash (styles live in index.html), so the hand-over
 * from "page is loading" to "app is checking the session" is seamless.
 */
export default function BrandLoader({ text = "Секунду…" }: { text?: string }) {
  return (
    <div id="lg-splash" role="status" aria-label="Загрузка" style={{ position: "fixed" }}>
      <div className="lg-moon"><div className="lg-moon__orbit"><i /><i /><i /></div><div className="lg-moon__disc" /></div>
      <img className="lg-logo" src={`${import.meta.env.BASE_URL}brand/logo-horizontal-white.svg`} alt="Luna Garden" style={{ opacity: 1, animation: "none" }} />
      <div className="lg-bar"><i /></div>
      <div className="lg-text">{text}</div>
    </div>
  );
}

/** Fade the HTML splash out once the app has rendered (at least ~1 s on the first visit of a session). */
export function useHideSplash(ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    const el = document.querySelector("body > #lg-splash");
    if (!el) return;
    let first = true;
    try { first = !sessionStorage.getItem("lg-splash-seen"); sessionStorage.setItem("lg-splash-seen", "1"); } catch { /* private mode */ }
    const started = (window as unknown as { __lgSplashStart?: number }).__lgSplashStart ?? Date.now();
    const wait = Math.max(0, (first ? 1100 : 0) - (Date.now() - started));
    const t = setTimeout(() => {
      el.classList.add("lg-hide");
      clearInterval((window as unknown as { __lgSplashTimer?: number }).__lgSplashTimer);
      setTimeout(() => el.remove(), 600);
    }, wait);
    return () => clearTimeout(t);
  }, [ready]);
}
