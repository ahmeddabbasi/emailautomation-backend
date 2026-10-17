import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { generateTestEmail } from "@/lib/generation";
import { jsonError, handleRouteError } from "@/lib/api-helpers";

const schema = z.object({
  instructions: z.string().min(1, "Instructions are required"),
  senderName: z.string().min(1, "Sender name is required"),
  senderTitle: z.string().default(""),
  rawStructure: z.string().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) return jsonError(400, "Invalid payload", { issues: parsed.error.issues });

    const generated = await generateTestEmail(
      parsed.data.instructions,
      { name: parsed.data.senderName, title: parsed.data.senderTitle },
      parsed.data.rawStructure
    );
    return NextResponse.json(generated);
  } catch (err) {
    return handleRouteError(err, "generation");
  }
}
