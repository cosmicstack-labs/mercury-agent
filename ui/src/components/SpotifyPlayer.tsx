import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import * as api from "@/lib/api";
import {
  Play,
  Pause,
  SkipForward,
  SkipBack,
  Music,
  X,
  ChevronUp,
} from "lucide-react";

export function SpotifyPlayer() {
  const [available, setAvailable] = useState(false);
  const [connected, setConnected] = useState(false);
  const [nowPlaying, setNowPlaying] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);

  const checkStatus = useCallback(async () => {
    try {
      const s = await api.spotify.status();
      setAvailable(s.available);
      setConnected(s.connected);
      if (s.connected) {
        const np = await api.spotify.nowPlaying();
        setNowPlaying(np.text);
        setIsPlaying(np.text !== "Nothing playing" && np.text !== "");
      }
    } catch {
      setAvailable(false);
    }
  }, []);

  useEffect(() => {
    checkStatus();
    const interval = setInterval(checkStatus, 10000);
    return () => clearInterval(interval);
  }, [checkStatus]);

  const action = async (fn: () => Promise<unknown>) => {
    setLoading(true);
    try {
      await fn();
      // Delay refresh to let Spotify catch up
      setTimeout(async () => {
        const np = await api.spotify.nowPlaying();
        setNowPlaying(np.text);
        setLoading(false);
      }, 600);
    } catch {
      setLoading(false);
    }
  };

  // Only show when Spotify is available, connected, and something is playing
  if (!available || !connected || !isPlaying) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ y: 80, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 80, opacity: 0 }}
        className={cn(
          "fixed bottom-6 right-6 z-50",
          "rounded-2xl border border-border/50",
          "bg-card/90 backdrop-blur-2xl shadow-2xl",
          "shadow-[0_0_30px_rgba(0,212,255,0.08)]",
          "transition-all duration-300",
          expanded ? "w-[320px]" : "w-auto"
        )}
      >
        {expanded ? (
          /* Expanded player */
          <div className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-[#1DB954]/10 flex items-center justify-center">
                  <Music size={16} className="text-[#1DB954]" />
                </div>
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Now Playing
                </span>
              </div>
              <button
                onClick={() => setExpanded(false)}
                className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              >
                <X size={14} />
              </button>
            </div>

            <p className="text-sm font-medium text-foreground truncate mb-4">
              {nowPlaying}
            </p>

            <div className="flex items-center justify-center gap-3">
              <button
                onClick={() => action(() => api.spotify.previous())}
                disabled={loading}
                className="p-2.5 rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              >
                <SkipBack size={18} />
              </button>
              <button
                onClick={() =>
                  action(isPlaying ? () => api.spotify.pause() : () => api.spotify.play())
                }
                disabled={loading}
                className="p-3 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 transition-colors shadow-lg shadow-primary/20 disabled:opacity-50"
              >
                {isPlaying ? <Pause size={20} /> : <Play size={20} />}
              </button>
              <button
                onClick={() => action(() => api.spotify.next())}
                disabled={loading}
                className="p-2.5 rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              >
                <SkipForward size={18} />
              </button>
            </div>
          </div>
        ) : (
          /* Collapsed pill */
          <button
            onClick={() => setExpanded(true)}
            className="flex items-center gap-3 px-4 py-3 group"
          >
            <div className="w-7 h-7 rounded-full bg-[#1DB954]/10 flex items-center justify-center flex-shrink-0">
              <Music size={14} className="text-[#1DB954]" />
            </div>
            <span className="text-sm text-foreground truncate max-w-[180px]">
              {nowPlaying}
            </span>
            <ChevronUp
              size={14}
              className="text-muted-foreground group-hover:text-foreground transition-colors flex-shrink-0"
            />
          </button>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
