import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { extractText } from "unpdf";
import mammoth from "mammoth";

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const MAX_TEXT_CHARS = 200_000;
// Below this much text a PDF almost certainly has no text layer (a scan).
const MIN_MEANINGFUL_CHARS = 40;

export type SupportedKind = "pdf" | "docx" | "text";

export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionError";
  }
}

export function documentKind(filename: string, mimeType: string): SupportedKind | null {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf" || mimeType === "application/pdf") return "pdf";
  if (ext === "docx" || mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";
  if (ext === "txt" || ext === "md" || ext === "markdown" || mimeType.startsWith("text/")) return "text";
  return null;
}

function normalise(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

export interface ExtractionResult {
  text: string;
  status: "ok" | "empty";
  warning: string | null;
}

function result(raw: string, emptyWarning: string): ExtractionResult {
  const text = normalise(raw);
  if (text.length < MIN_MEANINGFUL_CHARS) return { text, status: "empty", warning: emptyWarning };
  return { text, status: "ok", warning: null };
}

export async function extractDocumentText(data: Buffer, kind: SupportedKind): Promise<ExtractionResult> {
  try {
    if (kind === "pdf") {
      const { text } = await extractText(new Uint8Array(data), { mergePages: true });
      return result(
        text,
        "No readable text was found in this PDF. It is probably a scanned image; upload a text-based PDF or paste the content into Company facts."
      );
    }
    if (kind === "docx") {
      const { value } = await mammoth.extractRawText({ buffer: data });
      return result(value, "This Word document contains no readable text.");
    }
    return result(data.toString("utf8"), "This file is empty.");
  } catch (err) {
    throw new ExtractionError(`Could not read this ${kind.toUpperCase()} file: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function isPrivateAddress(ip: string): boolean {
  if (ip === "::1" || ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd")) return true;
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (isIP(v4) !== 4) return false;
  const [a, b] = v4.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// The server fetches whatever URL is saved, so it must never be pointed at
// internal infrastructure (cloud metadata endpoints, localhost services).
async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ExtractionError("That is not a valid URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ExtractionError("Only http and https links are supported.");
  if (url.hostname === "localhost" || url.hostname.endsWith(".local")) throw new ExtractionError("Links to local addresses are not allowed.");
  const addresses = isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true }).catch(() => []);
  if (addresses.length === 0) throw new ExtractionError(`Could not resolve ${url.hostname}.`);
  if (addresses.some((a) => isPrivateAddress(a.address))) throw new ExtractionError("Links to private network addresses are not allowed.");
  return url;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', mdash: ", ", ndash: "-", hellip: "..." };

function htmlToText(html: string): string {
  const body = html.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? html.match(/<article[\s\S]*?<\/article>/i)?.[0] ?? html.match(/<body[\s\S]*?<\/body>/i)?.[0] ?? html;
  return body
    .replace(/<(script|style|noscript|svg|nav|header|footer|form|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section)[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

export async function extractUrlText(raw: string): Promise<ExtractionResult & { finalUrl: string }> {
  let url = await assertPublicUrl(raw);
  let res: Response | null = null;
  // Follow redirects manually so every hop gets the same private-address check.
  for (let hop = 0; hop < 5; hop++) {
    res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": "EmailAutomationSystem/1.0 (knowledge base fetch)", Accept: "text/html,text/plain;q=0.9,*/*;q=0.5" },
    }).catch((err) => {
      throw new ExtractionError(`Could not reach ${url.hostname}: ${err instanceof Error ? err.message : String(err)}`);
    });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      url = await assertPublicUrl(new URL(location, url).toString());
      continue;
    }
    break;
  }
  if (!res) throw new ExtractionError("No response received.");
  if (!res.ok) throw new ExtractionError(`The page returned HTTP ${res.status}.`);

  const type = res.headers.get("content-type") ?? "";
  if (!/text\/html|text\/plain|application\/xhtml/.test(type)) {
    throw new ExtractionError(`Unsupported content type "${type.split(";")[0]}". Link to a web page, or upload the file instead.`);
  }
  const body = (await res.text()).slice(0, MAX_PAGE_BYTES);
  const text = type.includes("text/plain") ? body : htmlToText(body);
  return {
    ...result(text, "The page loaded but no readable text was found. It may render its content with JavaScript; paste the key facts into Company facts instead."),
    finalUrl: url.toString(),
  };
}
