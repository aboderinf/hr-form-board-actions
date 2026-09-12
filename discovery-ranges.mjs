// Keep these boundaries aligned with odds_band / score_band in src/discovery.py.
export const ODDS_RANGES = [
  { value: "below-400", label: "Below +400", max: 400 },
  { value: "400-499", label: "+400 to +499", min: 400, max: 500 },
  { value: "500-599", label: "+500 to +599", min: 500, max: 600 },
  { value: "600-799", label: "+600 to +799", min: 600, max: 800 },
  { value: "800-999", label: "+800 to +999", min: 800, max: 1000 },
  { value: "1000-plus", label: "+1000 or longer", min: 1000 },
];

export const FORM_RANGES = [
  { value: "400-plus", label: "0.400+", min: 0.4 },
  { value: "300-399", label: "0.300–0.399", min: 0.3, max: 0.4 },
  { value: "200-299", label: "0.200–0.299", min: 0.2, max: 0.3 },
  { value: "100-199", label: "0.100–0.199", min: 0.1, max: 0.2 },
  { value: "below-100", label: "Below 0.100", max: 0.1 },
];

export const DISCOVERY_BOOKS = ["FanDuel", "DraftKings", "BetMGM"];

export function resolveRange(ranges, value, customMin = "", customMax = "") {
  if (value !== "custom") return { ...(ranges.find((range) => range.value === value) || {}) };
  const min = String(customMin).trim() === "" ? undefined : Number(customMin);
  const max = String(customMax).trim() === "" ? undefined : Number(customMax);
  return { min, max, inclusiveMax: true };
}

export function rangeError(range, kind) {
  const bounds = [range.min, range.max].filter((value) => value !== undefined);
  if (bounds.some((value) => !Number.isFinite(value))) return "Enter a valid number for each bound.";
  if (kind === "odds" && bounds.some((value) => !Number.isInteger(value) || Math.abs(value) < 100)) {
    return "American odds must be whole numbers of +100 or higher, or −100 or lower.";
  }
  if (kind === "form" && bounds.some((value) => value < 0 || value > 1)) return "Form scores must be between 0 and 1.";
  if (range.min !== undefined && range.max !== undefined && range.min > range.max) return "Minimum must be no greater than maximum.";
  return "";
}

export function matchesRange(value, range) {
  if (range.min === undefined && range.max === undefined) return true;
  if (value == null || value === "" || !Number.isFinite(Number(value))) return false;
  const number = Number(value);
  return (range.min === undefined || number >= range.min)
    && (range.max === undefined || (range.inclusiveMax ? number <= range.max : number < range.max));
}

export function parseDiscoverySlice(label) {
  const parts = String(label || "").split(" · ");
  return {
    form: FORM_RANGES.find((range) => parts.includes(range.label))?.value || "all",
    odds: ODDS_RANGES.find((range) => parts.includes(range.label))?.value || "all",
    book: DISCOVERY_BOOKS.find((book) => parts.includes(book)) || "all",
    checkpoint: parts.find((part) => ["0817", "1117", "1717", "2017"].includes(part)),
  };
}

// Use the published summaries directly so slice records, sample sizes, and
// settlement exclusions remain identical to the existing Discovery report.
export function discoverySliceSummary(detail, form, odds, book = "all") {
  const formLabel = FORM_RANGES.find((range) => range.value === form)?.label;
  const oddsLabel = ODDS_RANGES.find((range) => range.value === odds)?.label;
  let table;
  let label;
  if (book !== "all") {
    table = formLabel && oddsLabel ? "book_odds_score" : formLabel ? "book_score" : oddsLabel ? "book_odds" : "best_price_books";
    label = [book, oddsLabel, formLabel].filter(Boolean).join(" · ");
  } else if (formLabel || oddsLabel) {
    table = formLabel && oddsLabel ? "score_odds" : formLabel ? "score_bands" : "odds_bands";
    label = [formLabel, oddsLabel].filter(Boolean).join(" · ");
  } else {
    return detail?.overall || null;
  }
  return detail?.[table]?.find((row) => row.label === label) || null;
}
