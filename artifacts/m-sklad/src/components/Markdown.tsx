import { Fragment, type ReactNode } from "react";

/**
 * Tiny, safe Markdown for AI answers: headings, bold/italic/code, lists, tables, paragraphs.
 * Builds React elements only — never injects HTML.
 */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**")) out.push(<strong key={`${key}-${i++}`}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith("`")) out.push(<code key={`${key}-${i++}`} className="rounded bg-black/5 px-1 text-[0.9em]">{t.slice(1, -1)}</code>);
    else out.push(<em key={`${key}-${i++}`}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

export default function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    const k = `b${i}`;
    if (!line.trim()) { i++; continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { blocks.push(<div key={k} className={`font-semibold ${h[1].length <= 2 ? "mt-2 text-base" : "mt-1"}`}>{inline(h[2], k)}</div>); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = cells(line); const rows: string[][] = []; i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      blocks.push(
        <div key={k} className="my-1 overflow-x-auto"><table className="w-full border-collapse text-sm">
          <thead><tr>{head.map((c, j) => <th key={j} className="border-b px-2 py-1 text-left font-medium">{inline(c, `${k}h${j}`)}</th>)}</tr></thead>
          <tbody>{rows.map((r, ri) => <tr key={ri} className="border-b last:border-0">{r.map((c, j) => <td key={j} className={`px-2 py-1 ${/^[\d\s.,%+−-]+( сом)?$/.test(c.replace(/\*/g, "")) ? "text-right tabular-nums" : ""}`}>{inline(c, `${k}r${ri}${j}`)}</td>)}</tr>)}</tbody>
        </table></div>,
      );
      continue;
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line); const items: string[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, ""));
      const L = ordered ? "ol" : "ul";
      blocks.push(<L key={k} className={`${ordered ? "list-decimal" : "list-disc"} space-y-0.5 pl-5`}>{items.map((t, j) => <li key={j}>{inline(t, `${k}l${j}`)}</li>)}</L>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*\||\s*([-*•]|\d+[.)])\s)/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) { para.push(lines[i++]); }
    blocks.push(<p key={k}>{para.map((p, j) => <Fragment key={j}>{j > 0 && <br />}{inline(p, `${k}p${j}`)}</Fragment>)}</p>);
  }
  return <div className="space-y-2 leading-relaxed">{blocks}</div>;
}
