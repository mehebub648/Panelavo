// Helpers for reasoning about a hostname without a full public-suffix list.
// The common multi-part suffixes below cover the cases where a naive
// "two labels = apex" rule would be wrong (e.g. example.co.uk).
const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au",
  "co.nz", "net.nz", "org.nz", "govt.nz",
  "co.za", "org.za", "co.in", "net.in", "org.in", "firm.in", "gen.in",
  "com.br", "net.br", "org.br", "com.mx", "com.sg", "com.my", "com.tr",
  "co.jp", "or.jp", "ne.jp", "co.kr", "or.kr", "com.cn", "net.cn", "org.cn",
]);

/**
 * True when `host` is a registrable/apex domain (e.g. example.com) rather than
 * a subdomain (e.g. www.example.com, panel.a.b.example.com).
 */
export function isApexDomain(host: string): boolean {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (labels.length < 2) return false;
  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_PART_SUFFIXES.has(lastTwo)) return labels.length === 3;
  return labels.length === 2;
}

/**
 * Additional subject-alternative-name(s) to request alongside the primary
 * domain when issuing a certificate.
 * - apex (example.com)      -> ["www.example.com"]
 * - www subdomain           -> [apex without the www prefix]
 * - any other subdomain     -> [] (just the domain itself)
 */
export function certAlternativeNames(host: string): string[] {
  const domain = host.toLowerCase().replace(/\.$/, "");
  if (domain.startsWith("www.")) return [domain.slice(4)];
  if (isApexDomain(domain)) return [`www.${domain}`];
  return [];
}

/**
 * The full set of A-record names to create when pointing a domain at this
 * server. Apex domains get both the bare domain and its www companion;
 * subdomains get only themselves.
 */
export function dnsRecordNames(host: string): string[] {
  const domain = host.toLowerCase().replace(/\.$/, "");
  if (isApexDomain(domain)) return [domain, `www.${domain}`];
  return [domain];
}
