// The appearance and editor settings follow the account (browser variant). The account copy is one JSON object of the
// synced settings, sealed under the personal key as `web_users.preferences` (docs/WEB-WSPOLDZIELENIE.md). Desktop keeps
// its settings local and never calls this. The same envelope carries the user's GitHub token (docs/GITHUB.md §7) under
// `githubToken`: it is never a setting, so the settings screen, applySyncedSettings and exports never see it.
import type { BrowserUser } from "./browserauth";
import { SYNCED_SETTINGS, applySyncedSettings, onSettingChanged, syncedSettings, type Settings } from "./settings";
import { openJson, sealJson } from "./profile";
import { api, type KeyEnvelope } from "./vaults";

const SAVE_DELAY_MS = 1000;
let account: { user: BrowserUser; personal: CryptoKey } | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let applying = false;
let listening = false;
let token: string | null = null;
let loaded: () => void = () => undefined;
/** Settles once the account copy was read (or could not be): the GitHub token is known from then on. */
export const preferencesLoaded = new Promise<void>((resolve) => { loaded = resolve; });

async function store(): Promise<void> {
  if (!account) return;
  const { user, personal } = account;
  const preferences = await sealJson({ ...syncedSettings(), ...(token ? { githubToken: token } : {}) }, personal);
  await api("/api/auth/me", "PATCH", { preferences });
  user.preferences = preferences;
}

function schedule(): void {
  clearTimeout(timer);
  timer = setTimeout(() => {
    store().catch((e: unknown) => console.warn("Ustawień nie udało się zapisać na koncie:", e instanceof Error ? e.message : e));
  }, SAVE_DELAY_MS);
}

/** Once after sign-in: the account copy wins; an account without one gets this device's settings. Failures keep the local ones. */
export async function syncPreferences(user: BrowserUser, personal: CryptoKey): Promise<void> {
  account = { user, personal };
  if (!listening) {
    listening = true;
    onSettingChanged((key) => { if (!applying && (SYNCED_SETTINGS as string[]).includes(key)) schedule(); });
  }
  try {
    if (!user.preferences) {
      await store();
      return;
    }
    const remote = await openJson<Partial<Settings> & { githubToken?: unknown }>(user.preferences as KeyEnvelope, personal);
    token = typeof remote.githubToken === "string" && remote.githubToken ? remote.githubToken : null;
    applying = true;
    try { applySyncedSettings(remote); } finally { applying = false; }
  } catch (e) {
    console.warn("Ustawień konta nie udało się wczytać:", e instanceof Error ? e.message : e);
  } finally {
    loaded();
  }
}

/** The user's personal GitHub token, or null. Only the GitHub service reads it. */
export function githubToken(): string | null { return token; }

/** Saves (or with null removes) the token in the sealed account copy now. A failed save keeps the old token. */
export async function setGithubToken(next: string | null): Promise<void> {
  if (!account) throw new Error("Zaloguj się, aby zapisać token GitHuba.");
  const before = token;
  token = next?.trim() || null;
  clearTimeout(timer);
  try { await store(); } catch (e) { token = before; throw e; }
}
