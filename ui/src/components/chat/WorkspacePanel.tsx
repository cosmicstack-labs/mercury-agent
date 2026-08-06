import { useState, useCallback } from "react";
import {
  X,
  Folder,
  File,
  ChevronRight,
  ArrowUp,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import api from "@/lib/api";
import type { WorkspaceTree, WorkspaceFile } from "@/lib/api";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

interface WorkspacePanelProps {
  open: boolean;
  onClose: () => void;
}

const EXT_LANG_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  py: "python",
  go: "go",
  rs: "rust",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  css: "css",
  html: "html",
  sh: "bash",
  bash: "bash",
  sql: "sql",
  toml: "toml",
  xml: "xml",
  dockerfile: "docker",
};

function getLanguage(ext: string): string {
  return EXT_LANG_MAP[ext.toLowerCase().replace(/^\./, "")] || "text";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function WorkspacePanel({ open, onClose }: WorkspacePanelProps) {
  const [tree, setTree] = useState<WorkspaceTree | null>(null);
  const [file, setFile] = useState<WorkspaceFile | null>(null);
  const [loading, setLoading] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadTree = useCallback(async (path?: string) => {
    setLoading(true);
    setError(null);
    setFile(null);
    try {
      const data = await api.workspace.tree(path);
      setTree(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workspace");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadFile = useCallback(async (path: string) => {
    setFileLoading(true);
    try {
      const data = await api.workspace.file(path);
      setFile(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load file");
    } finally {
      setFileLoading(false);
    }
  }, []);

  // Load tree on first open
  const [initialized, setInitialized] = useState(false);
  if (open && !initialized) {
    setInitialized(true);
    loadTree();
  }
  if (!open && initialized) {
    setInitialized(false);
  }

  if (!open) return null;

  // Build breadcrumb segments
  const breadcrumbs: { label: string; path: string }[] = [];
  if (tree) {
    const relative = tree.currentPath.replace(tree.root, "").replace(/^\//, "");
    if (relative) {
      const parts = relative.split("/");
      let accumulated = "";
      for (const part of parts) {
        accumulated = accumulated ? `${accumulated}/${part}` : part;
        breadcrumbs.push({ label: part, path: accumulated });
      }
    }
  }

  function navigateUp() {
    if (!tree) return;
    const rel = tree.currentPath.replace(tree.root, "").replace(/^\//, "");
    const parts = rel.split("/").filter(Boolean);
    if (parts.length <= 1) {
      loadTree();
    } else {
      parts.pop();
      loadTree(parts.join("/"));
    }
  }

  return (
    <div className="flex h-full w-full flex-col border-l border-border bg-background">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-foreground">Workspace</h2>
          {tree && (
            <p className="truncate text-xs text-muted-foreground">
              {tree.root}
            </p>
          )}
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} className="h-7 w-7 shrink-0">
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Breadcrumbs */}
      {tree && breadcrumbs.length > 0 && (
        <div className="flex items-center gap-1 border-b border-border px-4 py-2 text-xs">
          <button
            onClick={() => loadTree()}
            className="text-primary hover:underline"
          >
            root
          </button>
          {breadcrumbs.map((bc) => (
            <span key={bc.path} className="flex items-center gap-1">
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
              <button
                onClick={() => loadTree(bc.path)}
                className="text-primary hover:underline"
              >
                {bc.label}
              </button>
            </span>
          ))}
        </div>
      )}

      <ScrollArea className="flex-1">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          </div>
        ) : error ? (
          <div className="px-4 py-8 text-center text-sm text-destructive">
            {error}
          </div>
        ) : (
          <div className="flex flex-col">
            {/* File tree */}
            {tree && (
              <div className="border-b border-border">
                {/* Up button */}
                {breadcrumbs.length > 0 && (
                  <button
                    onClick={navigateUp}
                    className="flex w-full items-center gap-2 px-4 py-2 text-sm text-muted-foreground hover:bg-muted/50 transition-colors"
                  >
                    <ArrowUp className="h-4 w-4" />
                    <span>..</span>
                  </button>
                )}

                {tree.items.map((item) => (
                  <button
                    key={item.name}
                    onClick={() => {
                      if (item.type === "directory") {
                        const rel = tree.currentPath
                          .replace(tree.root, "")
                          .replace(/^\//, "");
                        const newPath = rel
                          ? `${rel}/${item.name}`
                          : item.name;
                        loadTree(newPath);
                      } else {
                        const rel = tree.currentPath
                          .replace(tree.root, "")
                          .replace(/^\//, "");
                        const filePath = rel
                          ? `${rel}/${item.name}`
                          : item.name;
                        loadFile(filePath);
                      }
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 px-4 py-2 text-sm transition-colors hover:bg-muted/50",
                      item.type === "directory"
                        ? "text-foreground"
                        : "text-foreground/80"
                    )}
                  >
                    {item.type === "directory" ? (
                      <Folder className="h-4 w-4 shrink-0 text-primary/70" />
                    ) : (
                      <File className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate">{item.name}</span>
                    {item.size !== undefined && item.type === "file" && (
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                        {formatSize(item.size)}
                      </span>
                    )}
                  </button>
                ))}

                {tree.items.length === 0 && (
                  <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                    Empty directory
                  </p>
                )}
              </div>
            )}

            {/* File preview */}
            {fileLoading && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
              </div>
            )}

            {file && !fileLoading && (
              <div className="flex flex-col">
                <div className="flex items-center justify-between border-b border-border px-4 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {file.name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatSize(file.size)}
                      {file.truncated && " (truncated)"}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setFile(null)}
                    className="h-6 text-xs"
                  >
                    Close
                  </Button>
                </div>
                <div className="overflow-auto text-xs">
                  <SyntaxHighlighter
                    language={getLanguage(file.ext)}
                    style={oneDark}
                    customStyle={{
                      margin: 0,
                      borderRadius: 0,
                      fontSize: "0.75rem",
                      lineHeight: "1.5",
                    }}
                    showLineNumbers
                    wrapLongLines
                  >
                    {file.content}
                  </SyntaxHighlighter>
                </div>
              </div>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
