import { useState, useCallback } from "react";
import { motion } from "framer-motion";
import { Copy, Check } from "lucide-react";
import type { ChatMessage } from "@/lib/api";
import { cn, formatDate } from "@/lib/utils";
import { useThemeStore } from "@/stores/theme";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { ToolCallCard } from "./ToolCallCard";

interface MessageBubbleProps {
  message: ChatMessage;
  isLast?: boolean;
}

export function MessageBubble({ message, isLast }: MessageBubbleProps) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === "user";
  const resolved = useThemeStore((s) => s.resolved);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [message.content]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      className={cn(
        "group flex gap-3",
        isUser ? "flex-row-reverse" : "flex-row"
      )}
    >
      {/* Avatar */}
      <div
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full text-xs font-semibold",
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-card"
        )}
      >
        {isUser ? (
          "U"
        ) : (
          <img
            src={resolved === "dark" ? "/logo-dark.png" : "/logo-light.png"}
            alt="Mercury"
            className="h-full w-full object-contain"
          />
        )}
      </div>

      {/* Content column */}
      <div
        className={cn(
          "relative max-w-[80%] space-y-1",
          isUser ? "items-end" : "items-start"
        )}
      >
        {/* Tool steps */}
        {message.steps?.map((step, i) => (
          <ToolCallCard
            key={`${message.id}-step-${i}`}
            tool={step.tool}
            status={step.status}
            result={step.result}
          />
        ))}

        {/* Bubble */}
        <div
          className={cn(
            "relative rounded-2xl px-4 py-2.5",
            isUser
              ? "rounded-br-sm bg-mercury-500 text-white"
              : "rounded-bl-sm border border-border/60 bg-card text-card-foreground"
          )}
        >
          {isUser ? (
            <p className="whitespace-pre-wrap text-sm leading-relaxed">
              {message.content}
            </p>
          ) : (
            <MarkdownRenderer content={message.content} />
          )}

          {/* Hover actions */}
          <div
            className={cn(
              "absolute -top-3 flex items-center gap-1 rounded-md border border-border bg-popover px-1 py-0.5 opacity-0 shadow-sm transition-opacity group-hover:opacity-100",
              isUser ? "right-0" : "left-0"
            )}
          >
            <button
              onClick={handleCopy}
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {copied ? (
                <Check className="h-3 w-3 text-emerald-500" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </button>
          </div>
        </div>

        {/* Timestamp */}
        <p
          className={cn(
            "px-1 text-[0.6875rem] text-muted-foreground",
            isUser ? "text-right" : "text-left"
          )}
        >
          {formatDate(message.timestamp)}
        </p>
      </div>
    </motion.div>
  );
}
