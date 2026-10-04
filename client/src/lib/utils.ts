import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merges class names, resolving conflicting Tailwind utilities (standard shadcn helper). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
