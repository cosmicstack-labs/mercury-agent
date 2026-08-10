export interface ViewportWindow {
  start: number;
  end: number;
  distanceFromBottom: number;
  maxDistanceFromBottom: number;
}

export function normalizeTerminalText(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export function getViewportWindow(totalLines: number, viewportLines: number, distanceFromBottom: number): ViewportWindow {
  const safeTotal = Math.max(0, totalLines);
  const safeViewport = Math.max(1, viewportLines);
  const maxDistanceFromBottom = Math.max(0, safeTotal - safeViewport);
  const distance = Math.max(0, Math.min(maxDistanceFromBottom, distanceFromBottom));
  const start = Math.max(0, safeTotal - safeViewport - distance);
  return {
    start,
    end: Math.min(safeTotal, start + safeViewport),
    distanceFromBottom: distance,
    maxDistanceFromBottom,
  };
}

export function moveViewport(
  distanceFromBottom: number,
  deltaTowardTop: number,
  totalLines: number,
  viewportLines: number,
): number {
  const { maxDistanceFromBottom } = getViewportWindow(totalLines, viewportLines, distanceFromBottom);
  return Math.max(0, Math.min(maxDistanceFromBottom, distanceFromBottom + deltaTowardTop));
}
