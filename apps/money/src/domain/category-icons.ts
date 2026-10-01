import * as Schema from "effect/Schema";

export const CATEGORY_ICON_NAMES = [
  "basket",
  "utensils",
  "coffee",
  "bus",
  "car",
  "home",
  "bolt",
  "droplet",
  "plane",
  "shield",
  "heart",
  "gift",
  "book",
  "music",
  "pet",
  "fitness",
  "shopping",
  "phone",
  "game",
  "flower",
  "graduation",
  "wallet",
  "sun",
  "tools",
] as const;

export const CategoryIconSchema = Schema.Literals(CATEGORY_ICON_NAMES);
export type CategoryIcon = Schema.Schema.Type<typeof CategoryIconSchema>;

export const CATEGORY_ICONS = {
  basket: { label: "Groceries", path: "M3 9h18l-2 11H5L3 9Zm4 0 5-6 5 6M9 13v3m6-3v3" },
  utensils: { label: "Dining", path: "M4 3v5c0 4 6 4 6 0V3M7 3v18M20 3c-5 3-5 9 0 9m0-9v18" },
  coffee: {
    label: "Coffee",
    path: "M4 8h12v7a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8Zm12 1h2a3 3 0 1 1 0 6h-2M7 3v2m6-2v2",
  },
  bus: {
    label: "Public transport",
    path: "M5 5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v13H5V5Zm0 5h14M8 14h1m6 0h1M7 18v3m10-3v3",
  },
  car: { label: "Car", path: "m5 8 2-5h10l2 5M3 8h18v10H3V8Zm3 5h2m8 0h2M5 18v3m14-3v3" },
  home: { label: "Home", path: "m3 10 9-7 9 7v11h-7v-8h-4v8H3V10Z" },
  bolt: { label: "Electricity", path: "m13 2-9 12h7l-1 8 10-13h-7l0-7Z" },
  droplet: { label: "Water", path: "M12 2S5 10 5 15a7 7 0 0 0 14 0c0-5-7-13-7-13Z" },
  plane: { label: "Travel", path: "m22 2-7 20-4-9-9-4L22 2Zm-11 11L22 2" },
  shield: { label: "Savings", path: "m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6l8-4Zm-4 10 3 3 5-6" },
  heart: {
    label: "Health",
    path: "M20 4a5 5 0 0 0-8 1 5 5 0 0 0-8-1c-5 5 0 10 8 16 8-6 13-11 8-16Z",
  },
  gift: {
    label: "Gifts",
    path: "M3 8h18v4H3V8Zm2 4v9h14v-9M12 8v13M12 8H8a3 3 0 1 1 3-3l1 3Zm0 0h4a3 3 0 1 0-3-3l-1 3Z",
  },
  book: {
    label: "Books",
    path: "M12 5C9 3 5 3 2 4v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1Zm0 0v15",
  },
  music: {
    label: "Music",
    path: "M9 18V5l12-2v13M9 9l12-2M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3Zm12-2a3 3 0 1 1-3-3 3 3 0 0 1 3 3Z",
  },
  pet: {
    label: "Pets",
    path: "M12 11c-2 0-3 3-5 5-3 4 0 6 5 4 5 2 8 0 5-4-2-2-3-5-5-5ZM6 7a2 2 0 1 0 0 .1M10 4a2 2 0 1 0 0 .1M16 4a2 2 0 1 0 0 .1M20 8a2 2 0 1 0 0 .1",
  },
  fitness: {
    label: "Fitness",
    path: "M7 9h10M7 15h10M3 8v8m4-11v14m10-14v14m4-11v8M3 12H1m20 0h2",
  },
  shopping: { label: "Shopping", path: "M4 7h16l1 14H3L4 7Zm4 0V6a4 4 0 0 1 8 0v1M8 10v1m8-1v1" },
  phone: {
    label: "Phone",
    path: "M6 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4Zm4 14h4M6 6h12",
  },
  game: {
    label: "Games",
    path: "M7 7h10c3 0 5 11 3 12-2 1-4-3-5-3H9c-1 0-3 4-5 3C2 18 4 7 7 7Zm0 4v4m-2-2h4m6-1h1m1 2h1",
  },
  flower: {
    label: "Garden",
    path: "M12 4c4-5 7 0 5 3 6 0 6 5 2 6 3 5-1 8-4 5-1 5-6 5-7 0-5 3-8-1-5-5-5-2-4-7 1-7-1-5 4-7 8-2Zm3 8a3 3 0 1 0-6 0 3 3 0 0 0 6 0Z",
  },
  graduation: { label: "Education", path: "m2 8 10-5 10 5-10 5L2 8Zm4 2v7c4 3 8 3 12 0v-7m4-2v10" },
  wallet: { label: "Money", path: "M3 6V4h15v3M3 6h18v15H3V6Zm18 5h-6v5h6m-4-3h1" },
  sun: {
    label: "Leisure",
    path: "M16 12a4 4 0 1 0-8 0 4 4 0 0 0 8 0ZM12 1v3m0 16v3M1 12h3m16 0h3M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2",
  },
  tools: {
    label: "Repairs",
    path: "M14 3a6 6 0 0 0-6 8l-6 6a3 3 0 0 0 4 4l6-6a6 6 0 0 0 8-6l-4 3-4-4 2-5Z",
  },
} satisfies Record<CategoryIcon, { label: string; path: string }>;
