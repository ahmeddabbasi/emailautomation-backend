import { NextRequest, NextResponse, after } from "next/server";
import { refreshLink, regenerateBriefQuietly } from "@/lib/knowledge";
import { jsonError, handleRouteError } from "@/lib/api-helpers";

export const maxDuration = 30;

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const item = await refreshLink(id);
    if (!item) return jsonError(404, "Link not found");
    if (item.status === "ok") after(() => regenerateBriefQuietly("refreshing a link"));
    return NextResponse.json({ item });
  } catch (err) {
    return handleRouteError(err, "knowledge");
  }
}
