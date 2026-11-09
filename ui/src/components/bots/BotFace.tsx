import { useEffect, useState } from "react";
import { botFace } from "@/lib/botFace";
import { cn } from "@/lib/utils";

/**
 * A bot's face: the photo its owner gave it, or — until there is one — a monogram on a
 * colour derived from the id (the same letters and colour the Android roster draws).
 *
 * `hasAvatar` comes from the roster, so the dashboard asks for bytes only for bots that
 * have a face; `broken` covers the other direction (bytes on disk that are not an image),
 * where a monogram beats a broken-image icon. `version` is the caller's cache-buster: the
 * server revalidates every request with an ETag, but React will not re-request an `<img>`
 * whose `src` never changed, so a face replaced elsewhere would otherwise stay stale.
 */
export function BotFace({
  id,
  name,
  hasAvatar,
  version = 0,
  size = 32,
  className,
}: {
  id: string;
  name?: string | null;
  hasAvatar?: boolean;
  version?: number;
  size?: number;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);

  // A new bot in the same slot (or a fresh id) gets a fresh chance to load its photo.
  useEffect(() => setBroken(false), [id, hasAvatar, version]);

  const box = { width: size, height: size };
  if (hasAvatar && !broken) {
    return (
      <img
        src={`/api/bots/${encodeURIComponent(id)}/avatar${version ? `?v=${version}` : ""}`}
        alt={`Photo of ${name || id}`}
        width={size}
        height={size}
        loading="eager"
        onError={() => setBroken(true)}
        className={cn("rounded-full object-cover shrink-0 ring-1 ring-border", className)}
        style={box}
      />
    );
  }

  const { monogram, background } = botFace(id, name);
  return (
    <span
      aria-hidden="true"
      title={name || id}
      className={cn("inline-flex items-center justify-center rounded-full shrink-0 select-none font-medium", className)}
      style={{ ...box, backgroundColor: background, color: "rgba(0, 0, 0, 0.75)", fontSize: Math.round(size * 0.38) }}
    >
      {monogram}
    </span>
  );
}
