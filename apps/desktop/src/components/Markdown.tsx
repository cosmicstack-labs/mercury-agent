import { Children, isValidElement, memo, useEffect, useState, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertTriangle, Check, CircleAlert, Copy, Info, Lightbulb, OctagonAlert, WrapText } from "lucide-react";
import { cx } from "~/lib/cx";
import { highlight, languageOf } from "./highlight";

/**
 * The agent's answers, rendered for reading:
 *  - code blocks: syntax highlighted (lazy Shiki, light + dark), language
 *    label, copy, soft-wrap toggle; not highlighted while still streaming;
 *  - task lists as real checkboxes, done items struck through;
 *  - GitHub alerts (> [!NOTE] / TIP / IMPORTANT / WARNING / CAUTION) as callouts;
 *  - tables in a scroll box; links open outside; images rounded.
 */
export const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const components: Components = {
    a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    pre: ({ children }) => <CodeBlock streaming={streaming}>{children}</CodeBlock>,
    code: ({ className, children, ...rest }) => <code className={className} {...rest}>{children}</code>,
    table: ({ children }) => <div className="md-table"><table>{children}</table></div>,
    blockquote: ({ children }) => <Blockquote>{children}</Blockquote>,
    li: ({ className, children }) => {
      const task = typeof className === "string" && className.includes("task-list-item");
      if (!task) return <li>{children}</li>;
      const items = Children.toArray(children);
      const box = items.find((c) => isValidElement(c) && (c as ReactElement<{ type?: string }>).props.type === "checkbox") as ReactElement<{ checked?: boolean }> | undefined;
      const checked = Boolean(box?.props.checked);
      const rest = items.filter((c) => c !== box);
      return (
        <li className={cx("md-task", checked && "md-task-done")}>
          <span className={cx("md-check", checked && "md-check-on")} aria-hidden="true">{checked && <Check size={11} strokeWidth={3} />}</span>
          <span className="sr-only">{checked ? "Done: " : "To do: "}</span>
          <span className="md-task-text">{rest}</span>
        </li>
      );
    },
    ul: ({ className, children }) => <ul className={cx(typeof className === "string" && className.includes("contains-task-list") && "md-task-list")}>{children}</ul>,
    input: () => null,
  };
  return (
    <div className="prose" data-selectable>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown>
    </div>
  );
});

function CodeBlock({ children, streaming }: { children: ReactNode; streaming: boolean }) {
  const child = Children.only(children) as ReactElement<{ className?: string; children?: ReactNode }>;
  const raw = extractText(child?.props?.children).replace(/\n$/, "");
  const langRaw = /language-([\w+#-]+)/.exec(child?.props?.className ?? "")?.[1];
  const lang = languageOf(langRaw);
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);

  useEffect(() => {
    if (streaming || !lang) { setHtml(null); return; }
    let live = true;
    void highlight(raw, lang).then((h) => { if (live) setHtml(h); }).catch(() => {});
    return () => { live = false; };
  }, [raw, lang, streaming]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(raw);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* blocked */ }
  }

  return (
    <div className="md-code group">
      <div className="md-code-bar">
        <span className="md-code-lang">{langRaw ?? "text"}</span>
        <span className="flex-1" />
        <button onClick={() => setWrap((w) => !w)} className={cx("md-code-btn", wrap && "md-code-btn-on")} aria-label="Wrap lines" title="Wrap lines"><WrapText size={13} /></button>
        <button onClick={() => void copy()} className="md-code-btn" aria-label="Copy code">{copied ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}</button>
      </div>
      {html
        ? <div className={cx("md-code-body", wrap && "md-wrap")} dangerouslySetInnerHTML={{ __html: html }} />
        : <pre className={cx("md-code-body", wrap && "md-wrap")}><code>{raw}</code></pre>}
    </div>
  );
}

const ALERTS = {
  NOTE: { icon: Info, label: "Note", tone: "md-alert-note" },
  TIP: { icon: Lightbulb, label: "Tip", tone: "md-alert-tip" },
  IMPORTANT: { icon: CircleAlert, label: "Important", tone: "md-alert-important" },
  WARNING: { icon: AlertTriangle, label: "Warning", tone: "md-alert-warning" },
  CAUTION: { icon: OctagonAlert, label: "Caution", tone: "md-alert-caution" },
} as const;

/** `> [!NOTE]` … becomes a callout; any other quote stays a quote. */
function Blockquote({ children }: { children: ReactNode }) {
  const items = Children.toArray(children).filter((c) => !(typeof c === "string" && !c.trim()));
  const first = items[0];
  if (isValidElement(first)) {
    const parts = Children.toArray((first as ReactElement<{ children?: ReactNode }>).props.children);
    const head = parts[0];
    const match = typeof head === "string" ? /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(head) : null;
    if (match) {
      const kind = match[1].toUpperCase() as keyof typeof ALERTS;
      const a = ALERTS[kind];
      const rest = [(head as string).slice(match[0].length), ...parts.slice(1)];
      return (
        <div className={cx("md-alert", a.tone)} role="note">
          <div className="md-alert-title"><a.icon size={15} aria-hidden="true" />{a.label}</div>
          <div className="md-alert-body">{rest.some((r) => typeof r !== "string" || r.trim()) && <p>{rest}</p>}{items.slice(1)}</div>
        </div>
      );
    }
  }
  return <blockquote>{children}</blockquote>;
}

function extractText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement(node)) return extractText((node as ReactElement<{ children?: ReactNode }>).props.children);
  return "";
}
