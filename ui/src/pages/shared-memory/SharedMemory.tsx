import { useEffect, useState, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Search, Plus, Trash2, Loader2, CheckCircle2, XCircle, Pause, Play, Share2,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { sharedMemory as api, type SharedMemoryStatus, type SharedMemoryRecord, type SharedMemoryCreate } from "@/lib/api";

const MEMORY_TYPES = ["identity","preference","goal","project","habit","decision","constraint","relationship","episode"] as const;
const TYPE_COLORS: Record<string, string> = {
  identity: "bg-blue-500/15 text-blue-400",
  preference: "bg-purple-500/15 text-purple-400",
  goal: "bg-amber-500/15 text-amber-400",
  project: "bg-cyan-500/15 text-cyan-400",
  habit: "bg-orange-500/15 text-orange-400",
  decision: "bg-indigo-500/15 text-indigo-400",
  constraint: "bg-red-500/15 text-red-400",
  relationship: "bg-pink-500/15 text-pink-400",
  episode: "bg-teal-500/15 text-teal-400",
};
const PAGE_SIZE = 50;

// Toast component
interface Toast { id: number; type: "success" | "error"; message: string }
function ToastBar({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div key={t.id} initial={{ opacity: 0, x: 40 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 40 }}
            className={cn("flex items-center gap-2 rounded-lg border px-4 py-3 text-sm shadow-lg backdrop-blur-sm",
              t.type === "success" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400" : "border-destructive/30 bg-destructive/10 text-destructive"
            )}>
            {t.type === "success" ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
            {t.message}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-lg bg-muted", className)} />;
}

function MemoryCardSkeleton() {
  return (
    <Card><CardContent className="p-5 space-y-3">
      <div className="flex items-center gap-3"><Skeleton className="h-5 w-20 rounded-md" /><Skeleton className="h-4 w-full" /></div>
      <Skeleton className="h-3 w-3/4" />
      <div className="flex items-center gap-4"><Skeleton className="h-3 w-16" /><Skeleton className="h-3 w-16" /><Skeleton className="h-3 w-20" /></div>
    </CardContent></Card>
  );
}

function ImportanceBar({ value }: { value: number }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-muted-foreground/70 shrink-0">Imp</span>
      <div className="flex gap-0.5">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className={cn("h-1.5 w-1.5 rounded-full transition-colors", i < Math.round(value * 10) ? "bg-[#a855f7]" : "bg-muted-foreground/15")} />
        ))}
      </div>
    </div>
  );
}

function MemoryItem({ memory, index }: { memory: SharedMemoryRecord; index: number }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <motion.div custom={index} variants={{ hidden: { opacity: 0, y: 12 }, visible: (i: number) => ({ opacity: 1, y: 0, transition: { delay: i * 0.04, duration: 0.3 } }), exit: { opacity: 0, y: -8 } }}
      initial="hidden" animate="visible" exit="exit" layout>
      <Card className="group transition-colors hover:border-[#a855f7]/20">
        <CardContent className="p-5">
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0 space-y-2">
              <div className="flex items-start gap-2 flex-wrap">
                <span className={cn("inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-xs font-semibold capitalize", TYPE_COLORS[memory.type] ?? "bg-muted text-muted-foreground")}>{memory.type}</span>
                <Badge variant="outline" className="text-xs border-[#a855f7]/30 text-[#a855f7]">{memory.category}</Badge>
                <p className="text-sm font-medium text-foreground leading-relaxed">{memory.summary}</p>
              </div>
              {memory.detail && (
                <button onClick={() => setExpanded(!expanded)} className="w-full text-left">
                  <p className={cn("text-sm text-muted-foreground leading-relaxed transition-all", !expanded && "line-clamp-2")}>{memory.detail}</p>
                  {memory.detail.length > 120 && <span className="text-xs text-[#a855f7]/70 hover:text-[#a855f7] mt-0.5 inline-block">{expanded ? "Show less" : "Show more"}</span>}
                </button>
              )}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-1">
                <ImportanceBar value={memory.importance} />
                <span className="text-xs text-muted-foreground/70">{Math.round(memory.confidence * 100)}% conf</span>
                <span className="text-xs text-muted-foreground/50">x{memory.evidenceCount}</span>
                <span className="text-xs text-muted-foreground/50">{new Date(memory.createdAt).toLocaleDateString()}</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

export default function SharedMemoryPage() {
  const [status, setStatus] = useState<SharedMemoryStatus | null>(null);
  const [memories, setMemories] = useState<SharedMemoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout>>();

  const toast = useCallback((type: "success" | "error", message: string) => {
    const id = Date.now();
    setToasts((p) => [...p, { id, type, message }]);
    setTimeout(() => setToasts((p) => p.filter((t) => t.id !== id)), 3000);
  }, []);

  const fetchStatus = useCallback(async () => {
    try { const s = await api.status(); setStatus(s); } catch {}
  }, []);

  const fetchMemories = useCallback(async (q?: string, off = 0) => {
    setLoading(true);
    try {
      const res = q
        ? await api.memories.search(q, PAGE_SIZE)
        : await api.memories.list({ limit: PAGE_SIZE, offset: off });
      setMemories(res.memories);
      setTotal(res.total);
    } catch { toast("error", "Failed to load memories"); }
    setLoading(false);
  }, [toast]);

  useEffect(() => { fetchStatus(); fetchMemories(); }, [fetchStatus, fetchMemories]);

  const handleSearch = useCallback((value: string) => {
    setSearchQuery(value);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => { setOffset(0); fetchMemories(value, 0); }, 300);
  }, [fetchMemories]);

  const handleCreate = async (data: SharedMemoryCreate) => {
    setCreating(true);
    try {
      await api.memories.create(data);
      toast("success", "Memory created");
      setCreateOpen(false);
      fetchMemories(searchQuery, offset);
      fetchStatus();
    } catch { toast("error", "Failed to create memory"); }
    setCreating(false);
  };

  const handleClear = async () => {
    try {
      const res = await api.memories.clear();
      toast("success", `Cleared ${res.deleted} memories`);
      fetchMemories();
      fetchStatus();
    } catch { toast("error", "Failed to clear memories"); }
  };

  const toggleLearning = async () => {
    if (!status) return;
    try {
      const res = await api.learning.set(!status.learningPaused);
      setStatus((s) => s ? { ...s, learningPaused: res.paused } : s);
      toast("success", res.paused ? "Learning paused" : "Learning resumed");
    } catch { toast("error", "Failed to toggle learning"); }
  };

  const hasMore = offset + PAGE_SIZE < total;

  return (
    <div className="space-y-6 p-6">
      <ToastBar toasts={toasts} />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Share2 className="h-6 w-6 text-[#a855f7]" />
          <div>
            <h1 className="text-2xl font-bold">Shared Memory</h1>
            {status && <p className="text-sm text-muted-foreground">{status.total} memories across {status.categories.length} categories</p>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={toggleLearning} className={status?.learningPaused ? "border-amber-500/30 text-amber-400" : "border-emerald-500/30 text-emerald-400"}>
            {status?.learningPaused ? <><Pause className="h-4 w-4 mr-1" /> Paused</> : <><Play className="h-4 w-4 mr-1" /> Learning</>}
          </Button>
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild><Button size="sm" className="bg-[#a855f7] hover:bg-[#a855f7]/90"><Plus className="h-4 w-4 mr-1" /> Add Memory</Button></DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Create Shared Memory</DialogTitle><DialogDescription>Add a new memory to the shared pool.</DialogDescription></DialogHeader>
              <CreateForm onSubmit={handleCreate} creating={creating} />
            </DialogContent>
          </Dialog>
          <AlertDialog>
            <AlertDialogTrigger asChild><Button size="sm" variant="destructive"><Trash2 className="h-4 w-4 mr-1" /> Clear All</Button></AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader><AlertDialogTitle>Clear all shared memories?</AlertDialogTitle><AlertDialogDescription>This action cannot be undone. All shared memories will be permanently deleted.</AlertDialogDescription></AlertDialogHeader>
              <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={handleClear}>Clear All</AlertDialogAction></AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input placeholder="Search shared memories..." value={searchQuery} onChange={(e) => handleSearch(e.target.value)} className="pl-10" />
      </div>

      {/* List */}
      <div className="space-y-3">
        {loading ? Array.from({ length: 5 }).map((_, i) => <MemoryCardSkeleton key={i} />) : memories.length === 0 ? (
          <Card><CardContent className="p-12 text-center text-muted-foreground"><Share2 className="h-12 w-12 mx-auto mb-4 opacity-30" /><p>No shared memories found</p></CardContent></Card>
        ) : (
          <AnimatePresence mode="popLayout">{memories.map((m, i) => <MemoryItem key={m.id} memory={m} index={i} />)}</AnimatePresence>
        )}
      </div>

      {/* Pagination */}
      {!loading && memories.length > 0 && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Showing {offset + 1}-{Math.min(offset + PAGE_SIZE, total)} of {total}</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => { const o = Math.max(0, offset - PAGE_SIZE); setOffset(o); fetchMemories(searchQuery, o); }}>Previous</Button>
            <Button size="sm" variant="outline" disabled={!hasMore} onClick={() => { const o = offset + PAGE_SIZE; setOffset(o); fetchMemories(searchQuery, o); }}>Next</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function CreateForm({ onSubmit, creating }: { onSubmit: (d: SharedMemoryCreate) => void; creating: boolean }) {
  const [type, setType] = useState("preference");
  const [category, setCategory] = useState("general");
  const [summary, setSummary] = useState("");
  const [detail, setDetail] = useState("");

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="text-sm font-medium mb-1.5 block">Type</label>
          <Select value={type} onValueChange={setType}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{MEMORY_TYPES.map((t) => <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-sm font-medium mb-1.5 block">Category</label>
          <Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="general" />
        </div>
      </div>
      <div>
        <label className="text-sm font-medium mb-1.5 block">Summary</label>
        <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="What should be remembered?" rows={2} />
      </div>
      <div>
        <label className="text-sm font-medium mb-1.5 block">Detail (optional)</label>
        <Textarea value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="Additional context..." rows={3} />
      </div>
      <DialogFooter>
        <Button onClick={() => onSubmit({ type, category, summary, detail: detail || undefined })} disabled={creating || !summary.trim()} className="bg-[#a855f7] hover:bg-[#a855f7]/90">
          {creating ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Plus className="h-4 w-4 mr-1" />} Create
        </Button>
      </DialogFooter>
    </div>
  );
}
