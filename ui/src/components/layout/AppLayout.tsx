import { Outlet, useLocation } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { SpotifyPlayer } from "../SpotifyPlayer";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";

export function AppLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const location = useLocation();

  useKeyboardShortcuts({
    onToggleSidebar: () => setSidebarOpen(!sidebarOpen),
  });
  const isChatPage = location.pathname === "/chat";

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Sidebar */}
      <Sidebar open={sidebarOpen} onToggle={() => setSidebarOpen(!sidebarOpen)} />

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 backdrop-blur-sm lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Main content */}
      <main
        className={cn(
          "flex-1 flex flex-col min-h-0 transition-all duration-300",
          sidebarOpen ? "lg:ml-[260px]" : "lg:ml-[72px]",
          isChatPage ? "overflow-hidden" : "overflow-y-auto"
        )}
      >
        {/* Top bar for mobile */}
        <header className="lg:hidden flex items-center h-14 px-4 border-b border-border bg-background/80 backdrop-blur-xl sticky top-0 z-20">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-2 -ml-2 rounded-lg hover:bg-muted text-foreground"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <span className="ml-3 text-sm font-semibold mercury-gradient-text">
            Mercury
          </span>
        </header>

        {/* Page content */}
        <div
          className={cn(
            "flex-1 min-h-0",
            isChatPage ? "flex flex-col" : "p-6 lg:p-8"
          )}
        >
          <Outlet />
        </div>
      </main>

      {/* Floating Spotify Player */}
      <SpotifyPlayer />
    </div>
  );
}
