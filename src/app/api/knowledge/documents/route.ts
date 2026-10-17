import { NextRequest, NextResponse, after } from "next/server";
import { addDocument, regenerateBriefQuietly, DOC_TYPES, type DocType } from "@/lib/knowledge";
import { documentKind, MAX_DOCUMENT_BYTES } from "@/lib/extraction";
import { jsonError, handleRouteError } from "@/lib/api-helpers";
import { logWarning } from "@/lib/logger";

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    const docType = String(form.get("docType") ?? "other") as DocType;
    if (!(file instanceof File)) return jsonError(400, "Choose a file to upload.");
    if (!DOC_TYPES.includes(docType)) return jsonError(400, "Choose a document type.");

    const kind = documentKind(file.name, file.type);
    if (!kind) {
      await logWarning("knowledge", "DOCUMENT_UNSUPPORTED_TYPE", "Rejected an upload with an unsupported file type", {
        details: { fileName: file.name, mimeType: file.type },
      });
      return jsonError(400, "Unsupported file type. Upload a PDF, DOCX, TXT, or MD file.");
    }
    if (file.size > MAX_DOCUMENT_BYTES) {
      await logWarning("knowledge", "DOCUMENT_TOO_LARGE", "Rejected an upload over the size limit", {
        details: { fileName: file.name, sizeBytes: file.size, limitBytes: MAX_DOCUMENT_BYTES },
      });
      return jsonError(400, "This file is larger than 10 MB. Upload a smaller file.");
    }

    const title = String(form.get("title") ?? "").trim() || file.name.replace(/\.[^.]+$/, "");
    const item = await addDocument({ name: file.name, type: file.type, data: Buffer.from(await file.arrayBuffer()) }, kind, docType, title);
    if (item.status === "ok") after(() => regenerateBriefQuietly("a document upload"));
    return NextResponse.json({ item }, { status: 201 });
  } catch (err) {
    return handleRouteError(err, "knowledge");
  }
}
