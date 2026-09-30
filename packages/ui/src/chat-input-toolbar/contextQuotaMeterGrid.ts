export function getContextQuotaMeterGridClass(count: number): string {
  // The Start/Coding quota comes from the server snapshot, and may actually be 1/2/3; official MCP
  // Changed to a through row below the grid, so the 320px float cannot be compressed into four columns even if misrepresenting the larger count.
  // Fixing three columns will leave holes in the two quotas, and will also cause the single quota to be meaninglessly narrowed.
  if (count <= 1) {
    return "grid-cols-1";
  }
  if (count === 2) {
    return "grid-cols-2";
  }
  if (count === 3) {
    return "grid-cols-3";
  }
  return "grid-cols-3";
}
