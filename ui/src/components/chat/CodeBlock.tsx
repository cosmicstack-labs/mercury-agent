import { useState, useCallback } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

interface CodeBlockProps {
  code: string;
  language?: string;
}

export function CodeBlock({ code, language }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [code]);

  const displayLang = language || "text";

  return (
    <div className="group relative my-3 overflow-hidden rounded-lg border border-border bg-[#282c34]">
      {/* Header bar */}
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-1.5 text-xs">
        <span className="font-mono text-muted-foreground">{displayLang}</span>
        <button
          onClick={handleCopy}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
            "text-muted-foreground hover:bg-white/10 hover:text-foreground"
          )}
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5 text-emerald-400" />
              <span className="text-emerald-400">Copied!</span>
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>

      {/* Code */}
      <SyntaxHighlighter
        language={language || "text"}
        style={oneDark}
        customStyle={{
          margin: 0,
          padding: "1rem",
          background: "transparent",
          fontSize: "0.8125rem",
          lineHeight: "1.6",
        }}
        showLineNumbers={false}
        wrapLongLines={false}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}
