import { clsx, type ClassValue } from "clsx";

export function cx(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
