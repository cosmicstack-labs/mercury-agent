import { useState, useCallback, useRef, type KeyboardEvent } from "react";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ChatInputProps {
  onSend: (content: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

const MAX_ROWS = 6;
const LINE_HEIGHT = 24;

export function ChatInput({
  onSend,
  disabled = false,
  placeholder = "Message Mercury...",
}: ChatInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const maxHeight = MAX_ROWS * LINE_HEIGHT;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [value, disabled, onSend]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  return (
    <div
      className={cn(
        "relative flex items-end gap-2 rounded-2xl border border-border/60 bg-card/80 px-4 py-3 shadow-lg backdrop-blur-sm transition-shadow",
        "focus-within:ring-2 focus-within:ring-mercury-500/40 focus-within:border-mercury-500/50",
        disabled && "opacity-60"
      )}
    >
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          adjustHeight();
        }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        className={cn(
          "flex-1 resize-none bg-transparent text-sm leading-6 text-foreground placeholder:text-muted-foreground",
          "focus:outline-none disabled:cursor-not-allowed"
        )}
        style={{ maxHeight: MAX_ROWS * LINE_HEIGHT }}
      />

      <Button
        size="icon"
        onClick={handleSend}
        disabled={disabled || !value.trim()}
        className="h-8 w-8 shrink-0 rounded-lg bg-mercury-500 text-white hover:bg-mercury-600 disabled:opacity-40"
      >
        <Send className="h-4 w-4" />
      </Button>
    </div>
  );
}
