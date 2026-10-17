import { NextResponse } from "next/server";
import { getKnowledgeOverview } from "@/lib/knowledge";
import { handleRouteError } from "@/lib/api-helpers";

export async function GET() {
  try {
    return NextResponse.json(await getKnowledgeOverview());
  } catch (err) {
    return handleRouteError(err, "settings");
  }
}
