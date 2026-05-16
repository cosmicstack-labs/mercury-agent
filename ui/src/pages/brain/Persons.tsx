import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { Search, Users, UserCircle, Brain } from "lucide-react";
import api, { type Person } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

// ── Skeleton ──

function PersonCardSkeleton() {
  return (
    <div className="rounded-xl border border-border bg-card p-5 animate-pulse">
      <div className="flex items-center gap-3 mb-3">
        <div className="h-11 w-11 rounded-full bg-muted" />
        <div className="flex-1 space-y-2">
          <div className="h-4 w-28 rounded bg-muted" />
          <div className="h-3 w-16 rounded bg-muted" />
        </div>
      </div>
      <div className="space-y-2 mb-3">
        <div className="h-3 w-full rounded bg-muted" />
        <div className="h-3 w-3/4 rounded bg-muted" />
      </div>
      <div className="flex gap-1.5">
        <div className="h-5 w-14 rounded bg-muted" />
        <div className="h-5 w-12 rounded bg-muted" />
      </div>
    </div>
  );
}

// ── Animation variants ──

const container = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.04 },
  },
};

const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: "easeOut" as const } },
};

// ── Page ──

export function PersonsPage() {
  const [persons, setPersons] = useState<Person[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchPersons = useCallback(async (q: string) => {
    try {
      setError(null);
      setLoading(true);
      const res = await api.brain.persons.list({
        q: q || undefined,
        limit: 200,
      });
      setPersons(res.persons);
      setTotal(res.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load persons");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPersons("");
  }, [fetchPersons]);

  const handleSearch = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchPersons(value), 300);
  };

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2.5">
          <Users className="h-6 w-6 text-[#00d4ff]" />
          <h1 className="text-2xl font-semibold text-foreground">
            Persons
            {!loading && (
              <span className="ml-2 text-base font-normal text-muted-foreground">
                ({total})
              </span>
            )}
          </h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          People Mercury knows about
        </p>
      </div>

      {/* Search */}
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search by name..."
          value={query}
          onChange={(e) => handleSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Error */}
      {error && (
        <Card>
          <CardContent className="py-8 text-center text-destructive">
            {error}
          </CardContent>
        </Card>
      )}

      {/* Loading */}
      {loading && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <PersonCardSkeleton key={i} />
          ))}
        </div>
      )}

      {/* Empty */}
      {!loading && !error && persons.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center text-muted-foreground">
            <UserCircle className="h-10 w-10" />
            <div>
              <p className="font-medium text-foreground">No persons found</p>
              <p className="text-sm">
                {query
                  ? "Try a different search term."
                  : "Mercury hasn't recorded any people yet."}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Grid */}
      {!loading && !error && persons.length > 0 && (
        <motion.div
          className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3"
          variants={container}
          initial="hidden"
          animate="show"
        >
          {persons.map((person) => (
            <motion.div key={person.id} variants={item}>
              <Link
                to={`/second-brain/persons/${person.id}`}
                className="block"
              >
                <Card
                  className={cn(
                    "cursor-pointer transition-all duration-200",
                    "hover:-translate-y-0.5 hover:shadow-lg hover:border-[#00d4ff]/30"
                  )}
                >
                  <CardContent className="p-5">
                    {/* Avatar + name */}
                    <div className="flex items-center gap-3 mb-3">
                      <Avatar className="h-11 w-11">
                        <AvatarFallback className="bg-[#00d4ff]/10 text-[#00d4ff] font-semibold text-sm">
                          {person.name.charAt(0).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-base font-semibold text-foreground">
                          {person.name}
                        </p>
                        {person.relationship && (
                          <Badge
                            variant="secondary"
                            className="mt-0.5 text-[10px] capitalize"
                          >
                            {person.relationship}
                          </Badge>
                        )}
                      </div>
                    </div>

                    {/* Summary */}
                    {person.summary && (
                      <p className="mb-3 line-clamp-2 text-sm text-muted-foreground">
                        {person.summary}
                      </p>
                    )}

                    {/* Footer: traits + memory count */}
                    <div className="flex flex-wrap items-center gap-1.5">
                      {person.traits?.slice(0, 4).map((trait) => (
                        <Badge
                          key={trait}
                          variant="outline"
                          className="text-[10px]"
                        >
                          {trait}
                        </Badge>
                      ))}
                      {person.memoryCount != null && person.memoryCount > 0 && (
                        <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
                          <Brain className="h-3 w-3" />
                          {person.memoryCount} memories
                        </span>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            </motion.div>
          ))}
        </motion.div>
      )}
    </div>
  );
}
