import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";
import { updateItem, deleteItem, regenerateBriefQuietly, DOC_TYPES } from "@/lib/knowledge";
import { jsonError, handleRouteError } from "@/lib/api-helpers";

const schema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  docType: z.enum(DOC_TYPES).optional(),
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError(400, "Invalid update", { issues: parsed.error.issues });
    const item = await updateItem(id, parsed.data);
    if (!item) return jsonError(404, "Item not found");
    if (parsed.data.enabled !== undefined || parsed.data.docType !== undefined) {
      after(() => regenerateBriefQuietly("a knowledge base change"));
    }
    return NextResponse.json({ item });
  } catch (err) {
    return handleRouteError(err, "knowledge");
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!(await deleteItem(id))) return jsonError(404, "Item not found");
    after(() => regenerateBriefQuietly("removing an item"));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleRouteError(err, "knowledge");
  }
}
