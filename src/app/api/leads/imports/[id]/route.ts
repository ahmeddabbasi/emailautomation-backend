import { NextRequest, NextResponse } from "next/server";
import { advanceImportJob } from "@/lib/import-jobs";
import { handleRouteError } from "@/lib/api-helpers";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const result = await advanceImportJob(id);
    return NextResponse.json(result);
  } catch (err) {
    return handleRouteError(err, "ingestion");
  }
}
