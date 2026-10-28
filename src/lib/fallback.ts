import type { CategoryKey, Place, TasteEntity } from "./types";

/**
 * Hand-written SAMPLE data, used only when the Qloo API is unreachable and
 * nothing is cached. It is NOT Qloo response data (Qloo's terms forbid storing
 * their responses in a public repo). Affinity here is a simple tag-overlap score.
 */

const KEYWORD_TAGS: [RegExp, string[]][] = [
  [/jazz|blues|soul|norah|coltrane|miles davis/i, ["Jazz", "Live music", "Cozy", "Intimate"]],
  [/radiohead|indie|arctic|tame impala|band|rock|hindia|efek rumah kaca|\.feast/i, ["Indie", "Alternative", "Live music", "Artsy"]],
  [/ghibli|anime|miyazaki|naruto|one piece|japan|sushi|ramen/i, ["Japanese", "Whimsical", "Artsy", "Cozy"]],
  [/coffee|kopi|tuku|starbucks|latte/i, ["Coffee", "Cozy", "Casual"]],
  [/taylor|pop|bts|blackpink|k-?pop|ariana|dua lipa/i, ["Pop", "Trendy", "Instagrammable", "Lively"]],
  [/marvel|avengers|star wars|nolan|interstellar|dune|sci-?fi/i, ["Sci-fi", "Blockbuster", "Lively"]],
  [/art|museum|gallery|van gogh|design/i, ["Artsy", "Cultural", "Quiet"]],
  [/sate|satay|rendang|nasi|padang|indonesian|warung/i, ["Indonesian", "Local favorite", "Casual"]],
  [/wine|cocktail|whisky|bar/i, ["Cocktails", "Nightlife", "Stylish"]],
  [/hiking|nature|park|beach|surf/i, ["Outdoors", "Green oasis", "Relaxing"]],
  [/book|novel|murakami|harry potter|tolkien/i, ["Literary", "Quiet", "Cozy"]],
];

export function fallbackSearch(q: string): TasteEntity {
  const tags = new Set<string>();
  for (const [re, t] of KEYWORD_TAGS) if (re.test(q)) t.forEach((x) => tags.add(x));
  if (tags.size === 0) ["Eclectic", "Casual"].forEach((x) => tags.add(x));
  return {
    id: "sample:" + q.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    name: q,
    type: "sample",
    tags: [...tags],
  };
}

type Seed = { name: string; area: string; tags: string[]; rating: number; price?: number; blurb: string };

const JAKARTA: Record<CategoryKey, Seed[]> = {
  dining: [
    { name: "Café Batavia", area: "Kota Tua, West Jakarta", tags: ["Historic", "Indonesian", "Live music", "Jazz", "Large group"], rating: 4.5, price: 3, blurb: "Colonial-era dining room on Fatahillah Square." },
    { name: "Ruang Selatan", area: "Kemang, South Jakarta", tags: ["Indonesian", "Artsy", "Relaxing", "Cultural"], rating: 4.4, price: 2, blurb: "Garden restaurant with a creative-space feel." },
    { name: "Sushi-ya (sample)", area: "Senopati, South Jakarta", tags: ["Japanese", "Cozy", "Intimate"], rating: 4.6, price: 3, blurb: "Small omakase-style counter." },
    { name: "Warung Local Favorite (sample)", area: "Menteng, Central Jakarta", tags: ["Indonesian", "Local favorite", "Casual", "Large group"], rating: 4.5, price: 1, blurb: "Comfort Indonesian food, built for sharing." },
    { name: "Neon Bistro (sample)", area: "SCBD, South Jakarta", tags: ["Trendy", "Instagrammable", "Pop", "Cocktails", "Lively"], rating: 4.3, price: 3, blurb: "Bright, buzzy bistro with a playlist to match." },
  ],
  coffee: [
    { name: "Tanamera Coffee (sample)", area: "Thamrin, Central Jakarta", tags: ["Coffee", "Indonesian", "Casual"], rating: 4.6, price: 2, blurb: "Single-origin Indonesian beans." },
    { name: "Bakery & Books Café (sample)", area: "Cikini, Central Jakarta", tags: ["Literary", "Quiet", "Cozy", "Coffee"], rating: 4.5, price: 2, blurb: "Pastries among the shelves." },
    { name: "Matcha House (sample)", area: "Kemang, South Jakarta", tags: ["Japanese", "Whimsical", "Instagrammable"], rating: 4.4, price: 2, blurb: "Matcha desserts in a pastel room." },
  ],
  culture: [
    { name: "Museum MACAN", area: "Kebon Jeruk, West Jakarta", tags: ["Artsy", "Cultural", "Modern art", "Instagrammable"], rating: 4.5, blurb: "Modern and contemporary art museum." },
    { name: "Komunitas Salihara", area: "Pasar Minggu, South Jakarta", tags: ["Artsy", "Cultural", "Live music", "Indie", "Literary"], rating: 4.6, blurb: "Independent arts center: theatre, music, talks." },
    { name: "Galeri Indonesia Kaya", area: "Grand Indonesia, Central Jakarta", tags: ["Cultural", "Indonesian", "Live music"], rating: 4.7, blurb: "Free performances of Indonesian arts." },
    { name: "Taman Literasi Martha Tiahahu", area: "Blok M, South Jakarta", tags: ["Outdoors", "Literary", "Relaxing", "Green oasis"], rating: 4.6, blurb: "Open-air reading park." },
  ],
  nightlife: [
    { name: "Jazz Lounge (sample)", area: "Kemang, South Jakarta", tags: ["Jazz", "Live music", "Intimate", "Cocktails"], rating: 4.5, price: 3, blurb: "Live trio most nights." },
    { name: "Indie Gig Bar (sample)", area: "Blok M, South Jakarta", tags: ["Indie", "Alternative", "Live music", "Lively"], rating: 4.4, price: 2, blurb: "Local bands, cheap drinks." },
    { name: "Karaoke Box (sample)", area: "Senayan, Central Jakarta", tags: ["Pop", "Lively", "Large group", "Trendy"], rating: 4.3, price: 2, blurb: "Private rooms for groups." },
  ],
};

function score(placeTags: string[], taste: string[]) {
  const t = new Set(taste.map((x) => x.toLowerCase()));
  const hits = placeTags.filter((x) => t.has(x.toLowerCase())).length;
  return Math.min(0.95, 0.35 + hits * 0.12);
}

export function fallbackPlaces(city: string, category: CategoryKey, tasteTags: string[]): Place[] {
  const isJakarta = /jakarta|jkt/i.test(city);
  return JAKARTA[category]
    .map((s, i) => ({
      id: `sample:${category}:${i}`,
      name: isJakarta ? s.name : s.name.replace(/\s*\(sample\)$/, "") + " (sample)",
      address: isJakarta ? s.area : `${city} (sample data)`,
      rating: s.rating,
      priceLevel: s.price,
      affinity: score(s.tags, tasteTags),
      tags: s.tags,
      description: s.blurb,
    }))
    .sort((a, b) => b.affinity - a.affinity);
}

const GENERIC: Record<string, string[]> = {
  jakarta: [
    "Dinner at a popular mall food court in Grand Indonesia",
    "Visit Monas (National Monument) and take photos",
    "Walk around Kota Tua and Fatahillah Square",
    "Finish with drinks at a rooftop bar in SCBD",
  ],
};

export function genericPlan(city: string): string[] {
  return (
    GENERIC[city.toLowerCase().split(/[ ,]/)[0]] || [
      `Dinner at a highly rated restaurant in central ${city}`,
      `Visit the most famous landmark in ${city}`,
      `Walk around the main shopping district`,
      `Drinks at a popular rooftop bar`,
    ]
  );
}
