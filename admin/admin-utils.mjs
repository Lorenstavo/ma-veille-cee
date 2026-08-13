export const REVIEW_STATUSES = new Set(["pending", "ignored", "analysis-ready"]);

function validHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function normalizePendingItems(value) {
  if (!Array.isArray(value)) throw new Error("La file technique pending est invalide.");
  const seen = new Set();
  return value.filter(item => {
    if (!item || typeof item !== "object" || typeof item.externalId !== "string" || !item.externalId || typeof item.title !== "string" || !item.title.trim() || !validHttpUrl(item.url) || seen.has(item.externalId)) return false;
    seen.add(item.externalId);
    return true;
  });
}

export function mergePendingReviews(pendingItems, reviews) {
  const byExternalId = new Map((reviews || []).filter(review => review && REVIEW_STATUSES.has(review.status)).map(review => [review.external_id, review]));
  return pendingItems.map(item => {
    const review = byExternalId.get(item.externalId);
    return { ...item, review: review || null, reviewStatus: review?.status || "pending" };
  });
}
