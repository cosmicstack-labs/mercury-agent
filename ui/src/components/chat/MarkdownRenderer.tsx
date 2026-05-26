import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock";
import { cn } from "@/lib/utils";

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

const components: Components = {
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className || "");
    const codeString = String(children).replace(/\n$/, "");

    // Fenced code blocks get rendered by CodeBlock
    if (match) {
      return <CodeBlock code={codeString} language={match[1]} />;
    }

    // Inline code
    return (
      <code
        className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8125rem] text-foreground"
        {...props}
      >
        {children}
      </code>
    );
  },

  pre({ children }) {
    // If pre wraps a CodeBlock, just pass through
    return <>{children}</>;
  },

  a({ href, children, ...props }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-mercury-500 underline decoration-mercury-500/40 underline-offset-2 transition-colors hover:text-mercury-400 hover:decoration-mercury-400"
        {...props}
      >
        {children}
      </a>
    );
  },

  h1({ children, ...props }) {
    return (
      <h1 className="mb-2 mt-4 text-lg font-semibold tracking-tight" {...props}>
        {children}
      </h1>
    );
  },
  h2({ children, ...props }) {
    return (
      <h2 className="mb-2 mt-3 text-base font-semibold tracking-tight" {...props}>
        {children}
      </h2>
    );
  },
  h3({ children, ...props }) {
    return (
      <h3 className="mb-1.5 mt-2.5 text-sm font-semibold" {...props}>
        {children}
      </h3>
    );
  },

  p({ children, ...props }) {
    return (
      <p className="mb-2 leading-relaxed last:mb-0" {...props}>
        {children}
      </p>
    );
  },

  ul({ children, ...props }) {
    return (
      <ul className="mb-2 ml-4 list-disc space-y-1 last:mb-0" {...props}>
        {children}
      </ul>
    );
  },
  ol({ children, ...props }) {
    return (
      <ol className="mb-2 ml-4 list-decimal space-y-1 last:mb-0" {...props}>
        {children}
      </ol>
    );
  },
  li({ children, ...props }) {
    return (
      <li className="leading-relaxed" {...props}>
        {children}
      </li>
    );
  },

  blockquote({ children, ...props }) {
    return (
      <blockquote
        className="my-2 border-l-2 border-mercury-500/50 pl-3 italic text-muted-foreground"
        {...props}
      >
        {children}
      </blockquote>
    );
  },

  table({ children, ...props }) {
    return (
      <div className="my-3 overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm" {...props}>
          {children}
        </table>
      </div>
    );
  },
  thead({ children, ...props }) {
    return (
      <thead className="border-b border-border bg-muted/50" {...props}>
        {children}
      </thead>
    );
  },
  tr({ children, ...props }) {
    return (
      <tr className="border-b border-border/50 transition-colors hover:bg-muted/30" {...props}>
        {children}
      </tr>
    );
  },
  th({ children, ...props }) {
    return (
      <th className="px-3 py-2 text-left font-medium" {...props}>
        {children}
      </th>
    );
  },
  td({ children, ...props }) {
    return (
      <td className="px-3 py-2" {...props}>
        {children}
      </td>
    );
  },

  hr() {
    return <hr className="my-4 border-border" />;
  },
};

export function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  return (
    <div className={cn("text-sm", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
