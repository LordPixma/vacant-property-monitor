// Every value here mirrors a CHECK constraint in migrations/. test/enums.test.ts replays the
// migration and fails if the two disagree.

export const ROLES = ["admin", "coordinator", "field_worker", "viewer"] as const;
export const CATEGORIES = ["council", "housing_association", "private", "commercial", "mixed_use", "unknown"] as const;
export const PROPERTY_TYPES = ["house", "flat", "bungalow", "maisonette", "hmo", "commercial", "land", "other"] as const;
export const STATUSES = [
  "reported",
  "suspected_vacant",
  "confirmed_vacant",
  "derelict",
  "abandoned",
  "referred",
  "brought_back_into_use",
  "occupied",
  "demolished",
] as const;
export const CONDITIONS = ["good", "fair", "poor", "derelict"] as const;
export const SECURITY = ["secured", "boarded", "partially_open", "open"] as const;
export const SOURCES = ["field", "admin", "import", "council_list", "public_report"] as const;
export const LOCATION_SOURCES = ["gps", "postcode", "manual"] as const;
export const TASK_TYPES = ["revisit", "refer_council", "refer_streetlink", "report_unsafe", "owner_contact", "research", "other"] as const;
export const TASK_STATUSES = ["open", "in_progress", "done", "cancelled"] as const;
export const PRIORITY_BANDS = ["critical", "high", "medium", "low"] as const;
export const SERVICE_GROUPS = ["shelter", "food_bank", "social_support", "health", "pharmacy", "community", "facilities", "police", "transport"] as const;
export const SERVICE_SOURCES = ["osm", "manual"] as const;
export const ENRICHMENT_STATUSES = ["pending", "running", "complete", "partial", "failed"] as const;

/** What a field worker can tick on a visit. Free to extend: stored as a JSON array, not CHECKed. */
export const SIGNALS = [
  "boarded_windows",
  "boarded_doors",
  "broken_windows",
  "overgrown_garden",
  "mail_piling_up",
  "no_curtains_or_furniture",
  "utilities_disconnected",
  "fly_tipping",
  "graffiti",
  "structural_damage",
  "roof_damage",
  "fire_damage",
  "open_or_unsecured",
  "signs_of_rough_sleeping",
  "signs_of_occupation",
  "for_sale_sign",
  "to_let_sign",
  "auction_sign",
  "scaffolding_or_works",
  "council_notice",
  "pest_infestation",
] as const;

export type Status = (typeof STATUSES)[number];
export type Category = (typeof CATEGORIES)[number];
export type Signal = (typeof SIGNALS)[number];

export const ACTIVE_STATUSES: Status[] = ["reported", "suspected_vacant", "confirmed_vacant", "derelict", "abandoned", "referred"];
