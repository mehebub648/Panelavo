// IANA timezone choices for selects, with a fallback for engines that lack
// Intl.supportedValuesOf. An unknown current value is kept selectable.
export function timezoneChoices(current?: string | null): string[] {
  let zones: string[];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = [
      "UTC",
      "Europe/London",
      "Europe/Berlin",
      "Europe/Paris",
      "America/New_York",
      "America/Chicago",
      "America/Los_Angeles",
      "Asia/Dhaka",
      "Asia/Kolkata",
      "Asia/Singapore",
      "Asia/Tokyo",
      "Australia/Sydney",
    ];
  }
  if (current && !zones.includes(current)) zones = [current, ...zones];
  return zones;
}
