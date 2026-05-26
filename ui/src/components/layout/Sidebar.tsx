import { NavLink, useLocation } from "react-router-dom";
import { cn } from "@/lib/utils";
import { useThemeStore } from "@/stores/theme";
import { ThemeToggle } from "./ThemeToggle";
import {
  LayoutDashboard,
  MessageSquare,
  ListTodo,
  Kanban,
  Code2,
  Brain,
  Users,
  Target,
  Share2,
  
  Cpu,
  Puzzle,
  Shield,
  Clock,
  BarChart3,
  Settings,
  LogOut,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface SidebarProps {
  open: boolean;
  onToggle: () => void;
}

const NAV_SECTIONS = [
  {
    items: [
      { to: "/", icon: LayoutDashboard, label: "Status" },
      { to: "/chat", icon: MessageSquare, label: "Chat" },
      { to: "/tasks", icon: ListTodo, label: "Tasks" },
      { to: "/board", icon: Kanban, label: "Board" },
      { to: "/workspace", icon: Code2, label: "Workspace" },
    ],
  },
  {
    title: "Second Brain",
    items: [
      { to: "/second-brain/memory", icon: Brain, label: "Memory" },
      { to: "/second-brain/persons", icon: Users, label: "Persons" },
      { to: "/second-brain/goals", icon: Target, label: "Goals" },
      { to: "/second-brain/graph", icon: Share2, label: "Graph" },
    ],
  },
  {
    title: "Configure",
    items: [
      { to: "/providers", icon: Cpu, label: "Providers" },
      { to: "/skills", icon: Puzzle, label: "Skills" },
      { to: "/permissions", icon: Shield, label: "Permissions" },
      { to: "/schedules", icon: Clock, label: "Schedules" },
      { to: "/usage", icon: BarChart3, label: "Usage" },
    ],
  },
];

export function Sidebar({ open, onToggle }: SidebarProps) {
  const location = useLocation();
  const resolved = useThemeStore((s) => s.resolved);

  return (
    <TooltipProvider delayDuration={0}>
      <aside
        className={cn(
          "fixed left-0 top-0 bottom-0 z-40 flex flex-col",
          "bg-card/95 backdrop-blur-xl border-r border-border/50",
          "transition-all duration-300 ease-in-out",
          open ? "w-[260px]" : "w-[72px]",
          // Mobile: slide in/out
          "max-lg:translate-x-0",
          !open && "max-lg:-translate-x-full"
        )}
      >
        {/* Logo */}
        <div
          className={cn(
            "flex items-center h-16 px-4 border-b border-border/50",
            open ? "justify-between" : "justify-center"
          )}
        >
          {open ? (
            <div className="flex items-center">
              <img
                src={resolved === "dark" ? "/logo-full-dark.png" : "/logo-full-light.png"}
                alt="Mercury Agent"
                className="max-w-[160px] h-auto"
              />
            </div>
          ) : (
            <img
              src={resolved === "dark" ? "/logo-dark.png" : "/logo-light.png"}
              alt="Mercury"
              className="w-8 h-8"
            />
          )}

          {/* Collapse toggle — desktop only */}
          <button
            onClick={onToggle}
            className={cn(
              "hidden lg:flex items-center justify-center w-7 h-7 rounded-md",
              "text-muted-foreground hover:text-foreground hover:bg-muted",
              "transition-colors",
              !open && "absolute -right-3 top-5 bg-card border border-border shadow-sm rounded-full w-6 h-6"
            )}
          >
            {open ? <ChevronLeft size={16} /> : <ChevronRight size={14} />}
          </button>
        </div>

        {/* Navigation */}
        <ScrollArea className="flex-1 py-3">
          <nav className="flex flex-col gap-1 px-3">
            {NAV_SECTIONS.map((section, si) => (
              <div key={si}>
                {si > 0 && <Separator className="my-3" />}
                {section.title && open && (
                  <p className="px-3 mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">
                    {section.title}
                  </p>
                )}
                {section.items.map((item) => {
                  const isActive =
                    item.to === "/"
                      ? location.pathname === "/"
                      : location.pathname.startsWith(item.to);

                  const link = (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      className={cn(
                        "group flex items-center gap-3 rounded-lg transition-all duration-150",
                        open ? "px-3 py-2.5" : "px-0 py-2.5 justify-center",
                        isActive
                          ? "bg-primary/10 text-primary"
                          : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                      )}
                    >
                      {/* Active indicator */}
                      <div
                        className={cn(
                          "absolute left-0 w-[3px] rounded-r-full transition-all",
                          isActive
                            ? "h-6 bg-primary shadow-[0_0_8px_rgba(0,212,255,0.4)]"
                            : "h-0"
                        )}
                      />

                      <item.icon
                        size={20}
                        className={cn(
                          "flex-shrink-0 transition-colors",
                          isActive && "text-primary"
                        )}
                      />
                      {open && (
                        <span className="text-sm font-medium truncate">
                          {item.label}
                        </span>
                      )}
                    </NavLink>
                  );

                  if (!open) {
                    return (
                      <Tooltip key={item.to}>
                        <TooltipTrigger asChild>{link}</TooltipTrigger>
                        <TooltipContent side="right" sideOffset={8}>
                          {item.label}
                        </TooltipContent>
                      </Tooltip>
                    );
                  }

                  return link;
                })}
              </div>
            ))}
          </nav>
        </ScrollArea>

        {/* Footer */}
        <div className="border-t border-border/50 p-3 space-y-1">
          {/* Settings */}
          {(() => {
            const isActive = location.pathname === "/settings";
            const link = (
              <NavLink
                to="/settings"
                className={cn(
                  "flex items-center gap-3 rounded-lg transition-all duration-150",
                  open ? "px-3 py-2.5" : "px-0 py-2.5 justify-center",
                  isActive
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                )}
              >
                <Settings size={20} />
                {open && (
                  <span className="text-sm font-medium">Settings</span>
                )}
              </NavLink>
            );

            return !open ? (
              <Tooltip>
                <TooltipTrigger asChild>{link}</TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  Settings
                </TooltipContent>
              </Tooltip>
            ) : (
              link
            );
          })()}

          {/* Theme + Logout row */}
          <div
            className={cn(
              "flex items-center",
              open ? "justify-between px-3 pt-1" : "flex-col gap-2 pt-1"
            )}
          >
            <ThemeToggle collapsed={!open} />
            {(() => {
              const btn = (
                <button
                  onClick={() => { window.location.href = "/api/auth/logout"; }}
                  className="p-2 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                >
                  <LogOut size={18} />
                </button>
              );
              return !open ? (
                <Tooltip>
                  <TooltipTrigger asChild>{btn}</TooltipTrigger>
                  <TooltipContent side="right" sideOffset={8}>
                    Logout
                  </TooltipContent>
                </Tooltip>
              ) : (
                btn
              );
            })()}
          </div>
        </div>
      </aside>
    </TooltipProvider>
  );
}
