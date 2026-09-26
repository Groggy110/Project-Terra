/**
 * Skill tags for a need, asked of the model in the same breath as any other
 * judgement about it. Shared by moderate-need (every new post) and tag-needs
 * (the one-off backfill), so both write the same vocabulary.
 */

export const TAG_RULES = `"tags": 6 to 10 lowercase skill and topic tags that a volunteer might type into a search box to find this need, ordered from MOST SPECIFIC to BROADEST. Start with the exact specialism (e.g. "logo design", "wordpress", "grant writing", "phone interpreting"), then closely related skills (e.g. "brand identity", "web design"), then the broad family it belongs to (e.g. "graphic design", "design", "writing", "translation", "healthcare", "construction"). Include languages the work needs (e.g. "arabic"). Use plain everyday words, 1 to 3 words each, no duplicates, no ministry or place names.`;

/** Cleans whatever the model returned into at most ten short tags. */
export function cleanTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const t of raw) {
    const tag = String(t ?? "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 40);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= 10) break;
  }
  return out;
}
