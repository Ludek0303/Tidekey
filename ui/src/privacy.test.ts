// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { OPERATOR, missingOperatorFields, type Operator } from "./legal";
import { publicPage, renderPage, renderPrivacy, showCookieNotice } from "./privacy";

afterEach(() => { localStorage.clear(); document.body.replaceChildren(); });

describe("privacy policy", () => {
  it("renders every section, with the operator and the cookie section to link to", () => {
    const root = document.createElement("div");
    renderPrivacy(root);
    expect(root.querySelector("h1")?.textContent).toBe("Polityka prywatności");
    expect(root.querySelector("#cookies")?.textContent).toContain("notes_session");
    expect(root.querySelectorAll("section")).toHaveLength(10);
  });

  it("says it is a draft, and names the gaps, until the operator has filled them in", () => {
    const root = document.createElement("div");
    renderPrivacy(root);
    if (missingOperatorFields().length) {
      expect(root.querySelector(".legal-draft")?.textContent).toContain("Dokument roboczy");
      expect(root.textContent).toContain("(do uzupełnienia)");
    } else expect(root.querySelector(".legal-draft")).toBeNull();
    const filled: Operator = { ...OPERATOR, name: "A", address: "B", email: "c@example.test", backups: "30 dni", transferBasis: "X", organizationRoles: "Y" };
    expect(missingOperatorFields(filled)).toEqual([]);
  });

  it("asks for no surname, and keeps terms acceptance apart from consent", () => {
    const root = document.createElement("div");
    renderPrivacy(root);
    expect(root.textContent).toContain("Nazwisko jest dobrowolne");
    expect(root.textContent).not.toContain("prawdziwe imię i nazwisko");
    const terms = document.createElement("div");
    renderPage(terms, "/regulamin");
    expect(terms.textContent).not.toContain("prawdziwe imię i nazwisko");
    expect(terms.textContent).toContain("nie jest zgodą");
    const help = document.createElement("div");
    renderPage(help, "/pomoc");
    expect(help.querySelector(".legal-draft")).toBeNull();
  });
});

describe("public pages", () => {
  it("routes the three paths, with or without a trailing slash, and nothing else", () => {
    expect(["/prywatnosc", "/regulamin/", "/pomoc", "/", "/v-1"].map(publicPage)).toEqual(["/prywatnosc", "/regulamin", "/pomoc", null, null]);
  });

  it("renders the terms and the help, each linking to the other pages", () => {
    for (const [path, title] of [["/regulamin", "Regulamin"], ["/pomoc", "Pomoc"]]) {
      const root = document.createElement("div");
      renderPage(root, path);
      expect(root.querySelector("h1")?.textContent).toBe(title);
      expect([...root.querySelectorAll(".legal-links a")].map((a) => a.getAttribute("href"))).not.toContain(path);
    }
    const help = document.createElement("div");
    renderPage(help, "/pomoc");
    expect(help.querySelector("#kod")?.textContent).toContain("nikt");
  });
});

describe("cookie notice", () => {
  it("shows on the first visit and stays closed once dismissed", () => {
    showCookieNotice();
    const notice = document.querySelector(".cookie-notice")!;
    expect(notice.querySelector("a")?.getAttribute("href")).toBe("/prywatnosc#cookies");
    notice.querySelector("button")!.click();
    expect(document.querySelector(".cookie-notice")).toBeNull();
    showCookieNotice();
    expect(document.querySelector(".cookie-notice")).toBeNull();
  });
});
