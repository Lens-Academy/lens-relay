import { generateKeyPairSync, createVerify } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleDocsClient, selectTab, loadServiceAccount } from "./client";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const account = {
  client_email: "sync@lens.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  token_uri: "https://oauth2.test/token",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("loadServiceAccount", () => {
  it("accepts the key file JSON or base64 of it", () => {
    const json = JSON.stringify(account);
    expect(loadServiceAccount(json).client_email).toBe(account.client_email);
    expect(loadServiceAccount(Buffer.from(json).toString("base64")).client_email).toBe(account.client_email);
  });

  it("names the variable when the key is missing or wrong", () => {
    expect(() => loadServiceAccount("")).toThrow("GOOGLE_SERVICE_ACCOUNT_JSON is not set");
    expect(() => loadServiceAccount("{nope")).toThrow(/is not a service-account key/);
    expect(() => loadServiceAccount("{}")).toThrow(/lacks client_email or private_key/);
    expect(() => loadServiceAccount(JSON.stringify({ ...account, private_key: "not a key" }))).toThrow(/private_key is not a valid PEM key/);
  });
});

describe("GoogleDocsClient", () => {
  it("signs a JWT, reuses the token, and asks for the doc without suggestions", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === account.token_uri) {
        const assertion = new URLSearchParams(String(init?.body)).get("assertion")!;
        const [head, claims, sig] = assertion.split(".");
        const valid = createVerify("RSA-SHA256").update(`${head}.${claims}`).verify(publicKey, Buffer.from(sig, "base64url"));
        const payload = JSON.parse(Buffer.from(claims, "base64url").toString());
        expect(valid).toBe(true);
        expect(payload).toMatchObject({ iss: account.client_email, aud: account.token_uri, scope: expect.stringContaining("documents.readonly") });
        return jsonResponse({ access_token: "tok", expires_in: 3600 });
      }
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tok");
      return jsonResponse({ documentId: "doc1", revisionId: "r1", tabs: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new GoogleDocsClient(account);
    await client.getDocument("doc1");
    await client.getDocument("doc1");

    const docCalls = fetchMock.mock.calls.filter(([url]) => String(url).startsWith("https://docs.googleapis.com/"));
    expect(fetchMock.mock.calls.filter(([url]) => url === account.token_uri)).toHaveLength(1);
    expect(docCalls).toHaveLength(2);
    const query = new URL(String(docCalls[0][0])).searchParams;
    expect(query.get("includeTabsContent")).toBe("true");
    expect(query.get("suggestionsViewMode")).toBe("PREVIEW_WITHOUT_SUGGESTIONS");
  });

  it("passes on Google's reason for an unreadable doc, with how to share it", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      url === account.token_uri
        ? jsonResponse({ access_token: "tok", expires_in: 3600 })
        : jsonResponse({ error: { message: "Google Docs API has not been used in project 123" } }, 403),
    );
    await expect(new GoogleDocsClient(account).getDocument("doc1")).rejects.toThrow(
      /\(403: Google Docs API has not been used in project 123\)\. If it is not shared, share it as "anyone with the link can view", or with sync@lens\.iam\.gserviceaccount\.com/,
    );
  });

  it("names Google when the network fails", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    await expect(new GoogleDocsClient(account).getDocument("doc1")).rejects.toThrow("Google: fetch failed");
  });

  it("follows redirects when downloading an image", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      url === "https://lh.test/a"
        ? new Response(null, { status: 302, headers: { location: "https://lh.test/b" } })
        : new Response(new Uint8Array([1, 2, 3])),
    );
    expect([...(await new GoogleDocsClient(account).getImage("https://lh.test/a", 100))]).toEqual([1, 2, 3]);
  });
});

describe("selectTab", () => {
  const child = { tabProperties: { tabId: "t.child", title: "Notes" }, documentTab: { lists: {} } };
  const doc = { documentId: "d1", tabs: [{ tabProperties: { tabId: "t.0", title: "Chapter" }, documentTab: {}, childTabs: [child] }] };

  it("finds a named tab, nested ones included", () => {
    expect(selectTab(doc, "t.child")).toBe(child);
  });

  it("needs the link to name a tab when the Doc has more than one", () => {
    expect(() => selectTab(doc, null)).toThrow('Google Doc d1 has 2 tabs; add ?tab=<id> to the link: t.0 "Chapter", t.child "Notes"');
    expect(selectTab({ tabs: [doc.tabs[0] && { ...doc.tabs[0], childTabs: [] }] }, null).tabProperties?.tabId).toBe("t.0");
  });

  it("names the tabs that exist when the link's tab is gone", () => {
    expect(() => selectTab(doc, "t.none")).toThrow('Google Doc d1 has no tab t.none; its tabs: t.0 "Chapter", t.child "Notes"');
  });
});
