export type PopulationGroup = "P1" | "DN" | "GABA" | "other";

/** Hex colors for population legend + instanced points. */
export function populationColor(group: string): string {
  switch (group) {
    case "P1":
      return "#e6b84d";
    case "DN":
      return "#e85d4c";
    case "GABA":
      return "#3db8c8";
    default:
      return "#5a6a7e";
  }
}

export function groupFromNeuron(type?: string, nt?: string): PopulationGroup {
  const t = type ?? "";
  const n = nt ?? "";
  if (t.includes("P1") || t.toLowerCase().includes("fru") || t.includes("Courtship")) return "P1";
  if (t.startsWith("DN") || t.includes("DNa") || t.includes("DNb")) return "DN";
  if (n === "gaba") return "GABA";
  return "other";
}
