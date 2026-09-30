/**
 * Read Google Docs through the Docs API as a service account.
 *
 * The API, not the public export, because it can leave pending suggestions
 * out (`PREVIEW_WITHOUT_SUGGESTIONS`): authors and reviewers work in
 * suggestion mode, and an unaccepted suggestion must never reach learners.
 * A doc shared "anyone with the link can view" is readable without sharing
 * it to the service account; a doc restricted to named people must be shared
 * with the account's `client_email`.
 *
 * Auth is a self-signed JWT exchanged for an access token (RFC 7523), done
 * with node:crypto so the server needs no Google SDK.
 */

import { createPrivateKey, createSign } from "node:crypto";
import { bytesToText, fetchBytesWithTimeout, type FetchBytesOptions, type FetchBytesResult } from "../../fetch-timeout";
import type { DocsDocument, DocsTab } from "./docs-types";

const DOCS_SCOPE = "https://www.googleapis.com/auth/documents.readonly";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const DOCS_API = "https://docs.googleapis.com/v1/documents";
const REQUEST_TIMEOUT_MS = 60_000;
// Chapter docs run to ~1.5 MB of JSON; far above that is not a doc we can use.
const MAX_DOC_BYTES = 50 * 1024 * 1024;

export const CREDENTIALS_ENV = "GOOGLE_SERVICE_ACCOUNT_JSON";

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

/** A non-2xx answer from Google, kept with its status so callers can tell passing failures from lasting ones. */
export class GoogleHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Parse the service-account key from GOOGLE_SERVICE_ACCOUNT_JSON: the key
 * file's JSON as-is, or base64 of it (easier to paste into an env file).
 */
export function loadServiceAccount(raw = process.env[CREDENTIALS_ENV]): ServiceAccount {
  const value = raw?.trim();
  if (!value) throw new Error(`${CREDENTIALS_ENV} is not set`);
  const json = value.startsWith("{") ? value : Buffer.from(value, "base64").toString("utf8");
  let parsed: Partial<ServiceAccount>;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`${CREDENTIALS_ENV} is not a service-account key (JSON or base64 JSON)`);
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error(`${CREDENTIALS_ENV} lacks client_email or private_key`);
  }
  try {
    createPrivateKey(parsed.private_key);
  } catch {
    throw new Error(`${CREDENTIALS_ENV} private_key is not a valid PEM key`);
  }
  return parsed as ServiceAccount;
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/** Google's own explanation from an error body (`{"error":{"message":…}}`), if any. */
function googleReason(resp: FetchBytesResult): string {
  try {
    return (JSON.parse(bytesToText(resp.bytes)) as { error?: { message?: string } }).error?.message ?? "";
  } catch {
    return bytesToText(resp.bytes).slice(0, 200);
  }
}

/** fetch, with network failures named as Google's (not the relay's). */
async function googleFetch(url: string, opts: FetchBytesOptions): Promise<FetchBytesResult> {
  try {
    return await fetchBytesWithTimeout(url, opts);
  } catch (err) {
    throw new Error(`Google: ${(err as Error).message}`);
  }
}

export class GoogleDocsClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly account: ServiceAccount) {}

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;

    const tokenUri = this.account.token_uri || DEFAULT_TOKEN_URI;
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
      JSON.stringify({
        iss: this.account.client_email,
        scope: DOCS_SCOPE,
        aud: tokenUri,
        iat: now,
        exp: now + 3600,
      }),
    )}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(this.account.private_key);
    const assertion = `${unsigned}.${base64url(signature)}`;

    const resp = await googleFetch(tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (!resp.ok) {
      throw new GoogleHttpError(resp.status, `Google token exchange failed: ${resp.status} ${bytesToText(resp.bytes)}`);
    }
    const body = JSON.parse(bytesToText(resp.bytes)) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  /** The whole document, every tab, with pending suggestions left out. */
  async getDocument(documentId: string): Promise<DocsDocument> {
    const token = await this.accessToken();
    const qs = new URLSearchParams({
      includeTabsContent: "true",
      suggestionsViewMode: "PREVIEW_WITHOUT_SUGGESTIONS",
    });
    const resp = await googleFetch(`${DOCS_API}/${encodeURIComponent(documentId)}?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxBytes: MAX_DOC_BYTES,
    });
    if (resp.status === 403 || resp.status === 404) {
      // Google's reason tells "not shared" apart from, say, the Docs API being off for the project.
      throw new GoogleHttpError(
        resp.status,
        `Google Doc ${documentId} is not readable (${resp.status}: ${googleReason(resp) || "no reason given"}). ` +
          `If it is not shared, share it as "anyone with the link can view", or with ${this.account.client_email}.`,
      );
    }
    if (!resp.ok) {
      throw new GoogleHttpError(resp.status, `Google Docs API ${resp.status}: ${googleReason(resp)}`);
    }
    return JSON.parse(bytesToText(resp.bytes)) as DocsDocument;
  }

  /**
   * Download an image by its `contentUri`. The URI is pre-signed and lives
   * about 30 minutes, so this must run soon after getDocument.
   */
  async getImage(contentUri: string, maxBytes: number): Promise<Uint8Array> {
    // fetchBytesWithTimeout never follows redirects; Google's image host may.
    let url = contentUri;
    for (let hop = 0; hop < 4; hop++) {
      const resp = await googleFetch(url, { timeoutMs: REQUEST_TIMEOUT_MS, maxBytes });
      const location = resp.headers.get("location");
      if (resp.status >= 300 && resp.status < 400 && location) {
        url = new URL(location, url).toString();
        continue;
      }
      if (!resp.ok) throw new GoogleHttpError(resp.status, `image download failed: ${resp.status}`);
      return new Uint8Array(resp.bytes);
    }
    throw new Error("image download failed: too many redirects");
  }
}

/**
 * The tab to sync. A link that names no tab is only enough for a one-tab
 * Doc: with several, the first tab may be a reviewers' notes tab, so the
 * binding must say which (`?tab=` in the link). Tabs nest; all are searched.
 */
export function selectTab(doc: DocsDocument, tabId: string | null): DocsTab {
  const all: DocsTab[] = [];
  const walk = (tabs: DocsTab[]) => tabs.forEach((t) => (all.push(t), walk(t.childTabs ?? [])));
  walk(doc.tabs ?? []);
  const list = () => all.map((t) => `${t.tabProperties?.tabId} "${t.tabProperties?.title ?? ""}"`).join(", ");

  if (!tabId) {
    if (all.length === 1) return all[0];
    throw new Error(`Google Doc ${doc.documentId} has ${all.length} tabs; add ?tab=<id> to the link: ${list()}`);
  }
  const tab = all.find((t) => t.tabProperties?.tabId === tabId);
  if (!tab) throw new Error(`Google Doc ${doc.documentId} has no tab ${tabId}; its tabs: ${list()}`);
  return tab;
}
