import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowLeft, Brain, Clock, UserCircle } from "lucide-react";
import api, { type Person, type Memory } from "@/lib/api";
import { cn, formatDate } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

// ── Animation ──

const fadeIn = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: "easeOut" as const } },
};

const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.03 } },
};

const listItem = {
  hidden: { opacity: 0, x: -8 },
  show: { opacity: 1, x: 0, transition: { duration: 0.25 } },
};

// ── Skeleton ──

function DetailSkeleton() {
  return (
    <div className="space-y-6 p-6 animate-pulse">
      <div className="h-4 w-32 rounded bg-muted" />
      <div className="flex items-center gap-4">
        <div className="h-16 w-16 rounded-full bg-muted" />
        <div className="space-y-2">
          <div className="h-6 w-40 rounded bg-muted" />
          <div className="h-4 w-20 rounded bg-muted" />
        </div>
      </div>
      <div className="space-y-2">
        <div className="h-4 w-full rounded bg-muted" />
        <div className="h-4 w-3/4 rounded bg-muted" />
      </div>
      <div className="flex gap-2">
        <div className="h-5 w-16 rounded bg-muted" />
        <div className="h-5 w-14 rounded bg-muted" />
        <div className="h-5 w-18 rounded bg-muted" />
      </div>
      <div className="h-5 w-28 rounded bg-muted mt-8" />
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="rounded-lg border border-border p-4 space-y-2">
          <div className="h-4 w-full rounded bg-muted" />
          <div className="h-3 w-24 rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

// ── Type badge color mapping ──

function typeBadgeVariant(
  type: string
): "default" | "secondary" | "success" | "warning" | "outline" {
  switch (type) {
    case "fact":
      return "default";
    case "preference":
      return "success";
    case "observation":
      return "warning";
    default:
      return "secondary";
  }
}

// ── Page ──

export function PersonDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [person, setPerson] = useState<Person | null>(null);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [memoryTotal, setMemoryTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!id) return;
    try {
      setError(null);
      setLoading(true);
      const [personRes, memoriesRes] = await Promise.all([
        api.brain.persons.get(id),
        api.brain.persons.memories(id, 50),
      ]);
      setPerson(personRes.person);
      setMemories(memoriesRes.memories);
      setMemoryTotal(memoriesRes.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load person");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) return <DetailSkeleton />;

  if (error || !person) {
    return (
      <div className="space-y-6 p-6">
        <Link
          to="/second-brain/persons"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Persons
        </Link>
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center text-muted-foreground">
            <UserCircle className="h-10 w-10" />
            <div>
              <p className="font-medium text-foreground">Person not found</p>
              <p className="text-sm">
                {error || "This person doesn't exist or has been removed."}
              </p>
            </div>
            <Link
              to="/second-brain/persons"
              className="mt-2 text-sm text-[#00d4ff] hover:underline"
            >
              Return to directory
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-8 p-6">
      {/* Back */}
      <motion.div variants={fadeIn} initial="hidden" animate="show">
        <Link
          to="/second-brain/persons"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Persons
        </Link>
      </motion.div>

      {/* Person header */}
      <motion.div
        className="space-y-4"
        variants={fadeIn}
        initial="hidden"
        animate="show"
      >
        <div className="flex items-center gap-4">
          <Avatar className="h-16 w-16">
            <AvatarFallback className="bg-[#00d4ff]/10 text-[#00d4ff] text-xl font-semibold">
              {person.name.charAt(0).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div>
            <h1 className="text-2xl font-bold text-foreground">
              {person.name}
            </h1>
            {person.relationship && (
              <Badge variant="secondary" className="mt-1 capitalize">
                {person.relationship}
              </Badge>
            )}
          </div>
        </div>

        {person.summary && (
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {person.summary}
          </p>
        )}

        {person.traits && person.traits.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {person.traits.map((trait) => (
              <Badge key={trait} variant="outline" className="text-xs">
                {trait}
              </Badge>
            ))}
          </div>
        )}
      </motion.div>

      {/* Memories */}
      <motion.div
        className="space-y-4"
        variants={fadeIn}
        initial="hidden"
        animate="show"
        transition={{ delay: 0.1 }}
      >
        <div className="flex items-center gap-2">
          <Brain className="h-5 w-5 text-[#00d4ff]" />
          <h2 className="text-lg font-semibold text-foreground">
            Memories
            <span className="ml-1.5 text-sm font-normal text-muted-foreground">
              ({memoryTotal})
            </span>
          </h2>
        </div>

        {memories.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              No memories associated with this person yet.
            </CardContent>
          </Card>
        ) : (
          <motion.div
            className="space-y-2"
            variants={stagger}
            initial="hidden"
            animate="show"
          >
            {memories.map((memory) => (
              <motion.div key={memory.id} variants={listItem}>
                <Card
                  className={cn(
                    "transition-colors hover:border-[#00d4ff]/20"
                  )}
                >
                  <CardContent className="flex items-start gap-3 p-4">
                    <Badge
                      variant={typeBadgeVariant(memory.type)}
                      className="mt-0.5 shrink-0 text-[10px] capitalize"
                    >
                      {memory.type}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-foreground">
                        {memory.summary}
                      </p>
                      <span className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        {formatDate(memory.createdAt)}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </motion.div>
        )}
      </motion.div>
    </div>
  );
}
