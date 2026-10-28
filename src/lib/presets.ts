import type { CategoryKey, Member } from "./types";

export interface Preset { id: string; label: string; city: string; occasion: string; members: Member[]; categories: CategoryKey[] }

/** One-click demo groups. Their AI plans are warmed and cached on the server (see src/lib/planCache.ts). */
export const PRESETS: Preset[] = [
  {
    id: "jakarta-friday",
    label: "Friday night, Jakarta",
    city: "Jakarta",
    occasion: "Friday night out",
    categories: ["dining", "culture", "nightlife"],
    members: [
      { name: "Aji", loves: ["Radiohead", "Studio Ghibli", "ramen"] },
      { name: "Dina", loves: ["Taylor Swift", "Gilmore Girls", "matcha"] },
      { name: "Raka", loves: ["Hindia", "Interstellar", "sate padang"] },
    ],
  },
  {
    id: "bandung-offsite",
    label: "Team offsite, Bandung",
    city: "Bandung",
    occasion: "Team offsite",
    categories: ["dining", "coffee", "culture"],
    members: [
      { name: "Sari", loves: ["Norah Jones", "Haruki Murakami"] },
      { name: "Budi", loves: ["Manchester United", "Fast & Furious"] },
      { name: "Lia", loves: ["BTS", "Crash Landing on You"] },
      { name: "Tom", loves: ["Anthony Bourdain", "The Bear"] },
    ],
  },
  {
    id: "yogya-date",
    label: "Date night, Yogyakarta",
    city: "Yogyakarta",
    occasion: "Date night",
    categories: ["dining", "coffee", "culture"],
    members: [
      { name: "Nadia", loves: ["Coldplay", "Before Sunrise", "gudeg"] },
      { name: "Fajar", loves: ["Pamungkas", "La La Land", "kopi tubruk"] },
    ],
  },
];
