function normalizedTemplateName(value: string) {
  return value.trim().toLowerCase().replace(/[._-]+/g, " ").replace(/\s+/g, " ");
}

export function defaultPhpVhostTemplate(templates: string[]) {
  const ranked = templates
    .map((template, index) => {
      const normalized = normalizedTemplateName(template);
      const words = new Set(normalized.split(" "));
      const rank =
        normalized === "generic"
          ? 0
          : words.has("generic") && words.has("php")
            ? 1
            : words.has("generic")
              ? 2
              : 3;
      return { template, index, rank };
    })
    .sort((left, right) => left.rank - right.rank || left.index - right.index);

  return ranked[0]?.template ?? "";
}
