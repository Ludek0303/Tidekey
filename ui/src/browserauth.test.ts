// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticateBrowser, chooseLogout, personNameError } from "./browserauth";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === label)!;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  document.body.innerHTML = "";
});

describe("display and last name rules", () => {
  it("accepts names in any script and with the usual punctuation", () => {
    for (const name of ["Ola", "Łucja", "Олена", "Jean-Luc", "O’Brien", "O'Brien", "Anna Maria", "Jan_2", "J. Kowalski"]) {
      expect(personNameError(name, "Imię"), name).toBeNull();
    }
  });

  it("rejects an empty name, one longer than 64 characters, and markup", () => {
    expect(personNameError("", "Imię")).toContain("Imię");
    expect(personNameError("a".repeat(65), "Imię")).toContain("64");
    expect(personNameError("<b>", "Imię")).toContain("Imię");
  });
});

// Opens the registration form with a fake server. The flow after a successful sign-up needs IndexedDB, which jsdom lacks,
// so the promise is allowed to reject there.
async function openRegister(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  const root = document.createElement("div");
  document.body.append(root);
  void authenticateBrowser(root).catch(() => undefined);
  await vi.waitFor(() => expect(root.querySelector("#auth-form")).not.toBeNull());
  root.querySelector<HTMLButtonElement>(".web-auth-switch")!.click();
  return root;
}
const serverAnswers = () => vi.fn(async (url: string) => (url === "/api/auth/me" ? json({ authenticated: false }) : json({ user: { id: "u1", email: "a@example.test", name: "Ola" } }, 201)));
const fill = (root: HTMLElement, values: Record<string, string>) => {
  // the confirmation repeats the password unless a test says otherwise
  const all = "password" in values && !("password2" in values) ? { ...values, password2: values.password } : values;
  for (const [name, value] of Object.entries(all)) (root.querySelector(`[name="${name}"]`) as HTMLInputElement).value = value;
  for (const box of ["terms"]) (root.querySelector(`[name="${box}"]`) as HTMLInputElement).checked = true;
};
const registerCalls = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.filter(([url]) => url === "/api/auth/register");

const answersWith = (registration: string) => vi.fn(async (url: string) => (url === "/api/auth/me" ? json({ authenticated: false, registration }) : json({ user: { id: "u1", email: "a@example.test", name: "Ola" } }, 201)));

describe("register form on a server that needs a code or an invite", () => {
  it("asks for the administrator's code and sends it", async () => {
    const fetchMock = answersWith("invite");
    const root = await openRegister(fetchMock);
    const row = root.querySelector<HTMLElement>("#auth-code-row")!;
    const code = root.querySelector<HTMLInputElement>('[name="code"]')!;
    expect(row.hidden).toBe(false);
    expect(code.required).toBe(true);
    expect(row.textContent).toContain("linku zaproszenia do organizacji");
    fill(root, { code: " abcd-efgh-jklm ", name: "Ola", email: "a@example.test", password: "Haslo123" });
    root.querySelector<HTMLFormElement>("#auth-form")!.requestSubmit();
    await vi.waitFor(() => expect(registerCalls(fetchMock)).toHaveLength(1));
    expect(JSON.parse((registerCalls(fetchMock)[0][1] as RequestInit).body as string).code).toBe("abcd-efgh-jklm");
  });

  it("hides the code field when signing in and on an open server", async () => {
    const root = await openRegister(answersWith("invite"));
    root.querySelector<HTMLButtonElement>(".web-auth-switch")!.click(); // back to signing in
    expect(root.querySelector<HTMLElement>("#auth-code-row")!.hidden).toBe(true);
    expect(root.querySelector<HTMLInputElement>('[name="code"]')!.required).toBe(false);
    const open = await openRegister(serverAnswers());
    expect(open.querySelector("#auth-code-row")).toBeNull();
  });

  it("offers no sign-up when registration is closed", async () => {
    vi.stubGlobal("fetch", answersWith("closed"));
    const root = document.createElement("div");
    document.body.append(root);
    void authenticateBrowser(root).catch(() => undefined);
    await vi.waitFor(() => expect(root.querySelector("#auth-form")).not.toBeNull());
    expect(root.querySelector<HTMLButtonElement>(".web-auth-switch")!.hidden).toBe(true);
    expect(root.textContent).toContain("Zakładanie nowych kont jest na tym serwerze wyłączone.");
  });
});

describe("register form", () => {
  it("asks for a display name (required) and an optional last name with the visibility hint", async () => {
    const root = await openRegister(serverAnswers());
    const name = root.querySelector<HTMLInputElement>('[name="name"]')!;
    const lastName = root.querySelector<HTMLInputElement>('[name="lastName"]')!;
    expect(root.querySelector("#auth-name-row")!.textContent).toContain("Imię lub nazwa wyświetlana");
    expect(name.required).toBe(true);
    expect(name.maxLength).toBe(64);
    expect(name.autocomplete).toBe("nickname");
    expect(lastName.required).toBe(false);
    expect(lastName.maxLength).toBe(64);
    expect(lastName.autocomplete).toBe("family-name");
    expect(root.querySelector("#auth-lastname-help")!.textContent).toContain("Możesz je pominąć i dodać później.");
    expect((root.querySelector('[name="terms"]') as HTMLInputElement).checked).toBe(false);
    expect(root.querySelector("#auth-terms-row")!.textContent).toContain("polityka prywatności");
    expect(root.querySelector("#auth-terms-row")!.textContent).toContain("ukończone 16 lat");
  });

  it("refuses a name with markup before any request is sent", async () => {
    const fetchMock = serverAnswers();
    const root = await openRegister(fetchMock);
    fill(root, { name: "<b>", email: "a@example.test", password: "Haslo123" });
    root.querySelector<HTMLFormElement>("#auth-form")!.requestSubmit();
    await vi.waitFor(() => expect(root.querySelector<HTMLElement>(".web-auth-error")!.hidden).toBe(false));
    expect(root.querySelector(".web-auth-error")!.textContent).toContain("Imię lub nazwa wyświetlana");
    expect(registerCalls(fetchMock)).toHaveLength(0);
  });

  it("sends the last name only when it is given", async () => {
    const fetchMock = serverAnswers();
    const root = await openRegister(fetchMock);
    fill(root, { name: "Łucja", lastName: "", email: "a@example.test", password: "Haslo123" });
    root.querySelector<HTMLFormElement>("#auth-form")!.requestSubmit();
    await vi.waitFor(() => expect(registerCalls(fetchMock)).toHaveLength(1));
    const body = JSON.parse((registerCalls(fetchMock)[0][1] as RequestInit).body as string);
    expect(body).toEqual({ name: "Łucja", email: "a@example.test", password: "Haslo123" });
    expect("lastName" in body).toBe(false);
  });

  it("refuses a confirmation that differs from the password before any request is sent", async () => {
    const fetchMock = serverAnswers();
    const root = await openRegister(fetchMock);
    fill(root, { name: "Ola", email: "a@example.test", password: "Haslo123", password2: "Haslo124" });
    root.querySelector<HTMLFormElement>("#auth-form")!.requestSubmit();
    await vi.waitFor(() => expect(root.querySelector<HTMLElement>(".web-auth-error")!.hidden).toBe(false));
    expect(root.querySelector(".web-auth-error")!.textContent).toBe("Hasła nie są takie same.");
    expect(registerCalls(fetchMock)).toHaveLength(0);
  });

  it("colors the password dots: grey when empty, yellow while typing, then red or green", async () => {
    const root = await openRegister(serverAnswers());
    vi.useFakeTimers();
    try {
      const type = (name: string, value: string) => {
        const input = root.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      const dot = (id: string) => root.querySelector<HTMLElement>(`#${id}`)!.dataset.state;
      expect(dot("auth-password-dot")).toBe("");
      type("password", "Haslo1");
      expect(dot("auth-password-dot")).toBe("typing");
      vi.advanceTimersByTime(599);
      expect(dot("auth-password-dot")).toBe("typing");
      vi.advanceTimersByTime(1);
      expect(dot("auth-password-dot")).toBe("bad");
      type("password", "Haslo123");
      vi.advanceTimersByTime(600);
      expect(dot("auth-password-dot")).toBe("ok");
      type("password2", "Haslo12");
      expect(dot("auth-password2-dot")).toBe("typing");
      vi.advanceTimersByTime(600);
      expect(dot("auth-password2-dot")).toBe("bad");
      expect(root.querySelector<HTMLElement>("#auth-password2-error")!.hidden).toBe(false);
      type("password2", "Haslo123");
      vi.advanceTimersByTime(600);
      expect(dot("auth-password2-dot")).toBe("ok");
      expect(root.querySelector<HTMLElement>("#auth-password2-error")!.hidden).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not send a typed last name either: it is stored encrypted after the key exists", async () => {
    const fetchMock = serverAnswers();
    const root = await openRegister(fetchMock);
    fill(root, { name: "O’Brien", lastName: "Łucja", email: "a@example.test", password: "Haslo123" });
    root.querySelector<HTMLFormElement>("#auth-form")!.requestSubmit();
    await vi.waitFor(() => expect(registerCalls(fetchMock)).toHaveLength(1));
    expect(JSON.parse((registerCalls(fetchMock)[0][1] as RequestInit).body as string)).not.toHaveProperty("lastName");
  });
});

describe("logout choice", () => {
  // Opens the choice, clicks the button for it, and waits until the server logout was asked for.
  async function chooseAndClick(label: string, fetchMock: ReturnType<typeof vi.fn>) {
    vi.stubGlobal("fetch", fetchMock);
    chooseLogout("u1");
    button(label).click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/auth/logout", expect.objectContaining({ method: "POST" })));
  }

  it("the plain logout keeps this device's copy and key", async () => {
    const open = vi.fn();
    vi.stubGlobal("indexedDB", { open });
    localStorage.setItem("notes.lastVault.v1.u1", "v-x");
    await chooseAndClick("Wyloguj", vi.fn(async () => json({})));
    await new Promise((r) => setTimeout(r, 0));
    expect(open).not.toHaveBeenCalled();
    expect(localStorage.getItem("notes.lastVault.v1.u1")).toBe("v-x");
  });

  it("the erase logout removes this user's local data and leaves the others", async () => {
    const open = vi.fn(() => ({}));
    vi.stubGlobal("indexedDB", { open });
    localStorage.setItem("notes.lastVault.v1.u1", "v-x");
    localStorage.setItem("notes.inbox.s1.u1", "[]");
    localStorage.setItem("notes.lastVault.v1.u2", "v-y");
    localStorage.setItem("notes.settings.v1", "{}");
    await chooseAndClick("Wyloguj i usuń dane z tego urządzenia", vi.fn(async () => json({})));
    await vi.waitFor(() => expect(open).toHaveBeenCalled());
    expect(localStorage.getItem("notes.lastVault.v1.u1")).toBeNull();
    expect(localStorage.getItem("notes.inbox.s1.u1")).toBeNull();
    expect(localStorage.getItem("notes.lastVault.v1.u2")).toBe("v-y");
    expect(localStorage.getItem("notes.settings.v1")).toBe("{}");
  });
});
