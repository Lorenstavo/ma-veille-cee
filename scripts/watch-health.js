(function (root, factory) {
  root.RegulatoryWatchHealth = factory();
})(typeof window !== "undefined" ? window : globalThis, function () {
  const tiers = {
    critical: {
      label: "Sources critiques",
      sources: ["Légifrance (JO, textes CEE)", "PNCEE", "Dispositif CEE — ecologie.gouv.fr", "Opérations standardisées — ecologie.gouv.fr", "Consultations publiques — developpement-durable.gouv.fr", "Questions-réponses CEE — ecologie.gouv.fr"]
    },
    important: {
      label: "Sources importantes",
      sources: ["Lettres d'information & Flash Info CEE — ecologie.gouv.fr", "Conseil supérieur de l'énergie (CSE)", "Registre national EMMY", "Liste des PAC agréées (bonus-pac.ademe.fr)"]
    },
    complementary: {
      label: "Sources complémentaires",
      sources: ["Cour des comptes — publications CEE", "ATEE — Club C2E", "Programmes CEE d'accompagnement — ecologie.gouv.fr", "Énergies — ecologie.gouv.fr"]
    }
  };

  function normalise(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function classifyWatch(watch) {
    const sourcesByName = new Map((Array.isArray(watch?.sources) ? watch.sources : []).map(source => [normalise(source.name), source]));
    const groups = Object.fromEntries(Object.entries(tiers).map(([key, tier]) => {
      const sources = tier.sources.map(name => {
        const source = sourcesByName.get(normalise(name)) || null;
        return { name, source, available: source?.status === "success" };
      });
      return [key, { key, label: tier.label, sources, available: sources.filter(source => source.available).length, total: sources.length }];
    }));
    const criticalUnavailable = groups.critical.available !== groups.critical.total;
    const otherUnavailable = groups.important.available !== groups.important.total || groups.complementary.available !== groups.complementary.total;
    const status = criticalUnavailable ? "critical" : otherUnavailable ? "degraded" : "operational";
    return { groups, status };
  }

  return { classifyWatch, normalise };
});
