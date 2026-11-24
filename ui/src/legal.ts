// Who runs this server, for the privacy policy (/prywatnosc) and the terms (/regulamin). Only the operator can fill
// these in (docs/RODO.md, "Informacje od operatora"); nothing here is guessed. While a field is null the pages say
// so in a visible "dokument roboczy" notice and print "(do uzupełnienia)" in its place. Not legal advice.
export interface Operator {
  /** The controller: a person's or a company's full name. */
  name: string | null;
  /** Postal address of the controller. */
  address: string | null;
  /** Contact for data-protection requests (Art. 13(1)(a) RODO). */
  email: string | null;
  /** Data protection officer, when one is appointed; null also when none is. */
  dpo: string | null;
  domain: string;
  /** How long backups of the server's data volume are kept, e.g. "30 dni", or "nie są wykonywane". */
  backups: string | null;
  /** The legal basis of transfers to Cloudflare outside the EEA, as confirmed by the operator. */
  transferBasis: string | null;
  /** Who decides about the content of an organization: filled in once the operator has settled the roles. */
  organizationRoles: string | null;
}

export const OPERATOR: Operator = {
  name: null,
  address: null,
  email: null,
  dpo: null,
  // The page's own host: the server that serves these pages is the operator's domain.
  domain: typeof location !== "undefined" && location.hostname ? location.hostname : "ten serwer",
  backups: null,
  transferBasis: null,
  organizationRoles: null,
};

export const PRIVACY_VERSION = "2026-10-29";

const LABELS: Record<Exclude<keyof Operator, "domain" | "dpo">, string> = {
  name: "nazwa administratora",
  address: "adres administratora",
  email: "kontakt w sprawach danych",
  backups: "okres przechowywania kopii zapasowych",
  transferBasis: "podstawa przekazywania danych poza EOG (Cloudflare)",
  organizationRoles: "role administratora i organizacji wobec treści organizacji",
};

/** The value, or a visible gap the operator has to fill in. */
export const field = (key: keyof Operator, operator: Operator = OPERATOR): string => operator[key] ?? "(do uzupełnienia)";

/** What the operator has not filled in yet; the legal pages are drafts until this is empty. */
export function missingOperatorFields(operator: Operator = OPERATOR): string[] {
  return (Object.keys(LABELS) as (keyof typeof LABELS)[]).filter((k) => !operator[k]).map((k) => LABELS[k]);
}
