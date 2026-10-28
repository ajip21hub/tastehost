import type { CategoryKey } from "./types";

export const CATEGORIES: Record<CategoryKey, { label: string; emoji: string; tags: string[] }> = {
  dining: { label: "Dinner", emoji: "🍽️", tags: ["urn:tag:category:place:restaurant"] },
  coffee: {
    label: "Coffee & dessert",
    emoji: "☕",
    tags: ["urn:tag:category:place:cafe", "urn:tag:category:place:coffee_shop"],
  },
  culture: {
    label: "Culture & activity",
    emoji: "🎨",
    tags: [
      "urn:tag:category:place:museum",
      "urn:tag:category:place:art_gallery",
      "urn:tag:category:place:tourist_attraction",
    ],
  },
  nightlife: {
    label: "Music & nightlife",
    emoji: "🎶",
    tags: [
      "urn:tag:category:place:bar",
      "urn:tag:category:place:live_music_venue",
      "urn:tag:category:place:karaoke",
    ],
  },
};

export const ALL_CATEGORIES = Object.keys(CATEGORIES) as CategoryKey[];

export function isCategory(x: unknown): x is CategoryKey {
  return typeof x === "string" && x in CATEGORIES;
}
