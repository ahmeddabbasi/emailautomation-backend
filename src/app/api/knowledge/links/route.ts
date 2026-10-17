import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";
import { addLink, regenerateBriefQuietly, DOC_TYPES } from "@/lib/knowledge";
import { jsonError, handleRouteError } from "@/lib/api-helpers";

const schema = z.object({
  url: z.string().trim().url("Enter a full URL, including https://"),
  title: z.string().trim().min(1, "Give the link a label").max(120),
  docType: z.enum(DOC_TYPES).default("other"),
});

export const maxDuration = 30;

export async function POST(request: NextRequest) {
  try {
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError(400, parsed.error.issues[0]?.message ?? "Invalid link");
    const item = await addLink(parsed.data.url, parsed.data.title, parsed.data.docType);
    if (item.status === "ok") after(() => regenerateBriefQuietly("adding a link"));
    return NextResponse.json({ item }, { status: 201 });
  } catch (err) {
    return handleRouteError(err, "knowledge");
  }
}
