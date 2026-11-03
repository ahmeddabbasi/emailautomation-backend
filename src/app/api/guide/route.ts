import { NextResponse } from "next/server";
import { buildGuide } from "@/lib/guide";
import { handleRouteError } from "@/lib/api-helpers";

export async function GET() {
  try {
    return NextResponse.json(await buildGuide());
  } catch (err) {
    return handleRouteError(err, "settings");
  }
}
