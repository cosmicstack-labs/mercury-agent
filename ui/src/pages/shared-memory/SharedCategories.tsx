import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { FolderOpen, Loader2, Tag } from "lucide-react";
import { sharedMemory } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface CategoriesData {
  categories: string[];
  byCategory: Record<string, number>;
}

export default function SharedCategories() {
  const [data, setData] = useState<CategoriesData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    sharedMemory
      .categories()
      .then((res: CategoriesData) => setData(res))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="mx-auto max-w-5xl space-y-8 p-6">
      <div className="flex items-center gap-3">
        <FolderOpen className="h-7 w-7" style={{ color: "#a855f7" }} />
        <h1 className="text-2xl font-bold tracking-tight">
          Shared Memory Categories
        </h1>
      </div>

      {loading && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="animate-pulse">
              <CardHeader>
                <div className="h-5 w-2/3 rounded bg-muted" />
              </CardHeader>
              <CardContent>
                <div className="h-4 w-1/4 rounded bg-muted" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {!loading && (!data || data.categories.length === 0) && (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-muted-foreground">
          <Tag className="h-10 w-10" />
          <p className="text-lg">No categories yet</p>
        </div>
      )}

      {!loading && data && data.categories.length > 0 && (
        <AnimatePresence>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.categories.map((category, i) => (
              <motion.div
                key={category}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05 }}
              >
                <Card
                  className={cn(
                    "cursor-pointer transition-shadow hover:shadow-md",
                    "border-l-4"
                  )}
                  style={{ borderLeftColor: "#a855f7" }}
                >
                  <CardHeader className="flex flex-row items-center justify-between pb-2">
                    <CardTitle className="text-base font-medium">
                      {category}
                    </CardTitle>
                    <Badge
                      variant="secondary"
                      className="tabular-nums"
                      style={{ backgroundColor: "#a855f720", color: "#a855f7" }}
                    >
                      {data.byCategory[category] ?? 0}
                    </Badge>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <p className="text-xs text-muted-foreground">
                      {data.byCategory[category] === 1
                        ? "1 memory"
                        : `${data.byCategory[category] ?? 0} memories`}
                    </p>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
        </AnimatePresence>
      )}
    </div>
  );
}
