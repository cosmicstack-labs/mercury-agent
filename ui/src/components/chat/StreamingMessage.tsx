import { MarkdownRenderer } from "./MarkdownRenderer";
import { ToolCallCard } from "./ToolCallCard";
import { useThemeStore } from "@/stores/theme";

interface StreamingMessageProps {
  text: string;
  steps?: { tool: string; status: string }[];
}

export function StreamingMessage({ text, steps }: StreamingMessageProps) {
  const isThinking = !text;
  const resolved = useThemeStore((s) => s.resolved);

  return (
    <div className="flex gap-3">
      {/* Avatar */}
      <div className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-card">
        <img
          src={resolved === "dark" ? "/logo-dark.png" : "/logo-light.png"}
          alt="Mercury"
          className="h-full w-full object-contain"
        />
      </div>

      {/* Content */}
      <div className="max-w-[80%] space-y-1">
        {/* Tool steps */}
        {steps?.map((step, i) => (
          <ToolCallCard
            key={`stream-step-${i}`}
            tool={step.tool}
            status={step.status as "running" | "done" | "error"}
          />
        ))}

        {/* Bubble */}
        <div className="rounded-2xl rounded-bl-sm border border-border/60 bg-card px-4 py-2.5 text-card-foreground">
          {isThinking ? (
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
              <span>Thinking</span>
              <span className="inline-flex w-5">
                <span className="animate-pulse">...</span>
              </span>
            </div>
          ) : (
            <div className="inline">
              <MarkdownRenderer content={text} />
              <span className="ml-0.5 inline-block h-4 w-[3px] translate-y-[2px] rounded-sm bg-mercury-500 animate-cursor-blink" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
