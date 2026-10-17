import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { commitContacts, type MappingKey } from "@/lib/ingestion";
import { jsonError, handleRouteError } from "@/lib/api-helpers";

const IDENTITY_MAPPING: Record<MappingKey, string | null> = {
  name: "name",
  first_name: null,
  last_name: null,
  email: "email",
  company: "company",
  title: "title",
  bio: "bio",
};

const manualSchema = z.object({
  leadListId: z.string().uuid(),
  name: z.string().min(1, "Name is required"),
  email: z.string().min(1, "Email is required"),
  company: z.string().default(""),
  title: z.string().default(""),
  bio: z.string().default(""),
});

// Adds a single contact by routing through the exact same commitContacts()
// path the CSV import uses — one synthetic row with an identity mapping —
// so validation and dedupe-by-email behave identically either way.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = manualSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(400, "Invalid contact payload", { issues: parsed.error.issues });
    }

    const { leadListId, ...fields } = parsed.data;
    const result = await commitContacts([fields], IDENTITY_MAPPING, leadListId, "manual");

    if (result.inserted === 0) {
      const reason = result.rejected[0]?.reason ?? "Already enrolled in this list";
      return jsonError(409, reason);
    }

    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    return handleRouteError(err, "ingestion");
  }
}
