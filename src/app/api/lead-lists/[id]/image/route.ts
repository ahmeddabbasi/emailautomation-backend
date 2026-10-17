import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { jsonError, handleRouteError } from "@/lib/api-helpers";
import { ExternalServiceError, errorMessage } from "@/lib/errors";

const BUCKET = "campaign-assets";
const MAX_BYTES = 5 * 1024 * 1024;

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) return jsonError(400, "Missing file");
    if (!file.type.startsWith("image/")) return jsonError(400, "File must be an image");
    if (file.size > MAX_BYTES) return jsonError(400, "Image must be under 5MB");

    const buffer = Buffer.from(await file.arrayBuffer());
    const ext = file.name.split(".").pop() || "png";
    const path = `${id}/${Date.now()}.${ext}`;

    const db = supabaseAdmin();
    const { error } = await db.storage.from(BUCKET).upload(path, buffer, {
      contentType: file.type,
      upsert: true,
    });
    if (error) throw new ExternalServiceError("supabase", `Failed to upload image: ${errorMessage(error)}`, error);

    const { data } = db.storage.from(BUCKET).getPublicUrl(path);
    return NextResponse.json({ url: data.publicUrl, filename: file.name });
  } catch (err) {
    return handleRouteError(err);
  }
}
