import { CheckSquare } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

export function TasksPage() {
  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center gap-2">
        <CheckSquare className="h-6 w-6 text-muted-foreground" />
        <h1 className="text-2xl font-semibold text-foreground">Tasks</h1>
      </div>
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          Task management coming soon.
        </CardContent>
      </Card>
    </div>
  );
}
