import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { suppressEmail, tokenMatches } from "@/lib/suppression";

export async function GET(request: NextRequest) {
  const email = request.nextUrl.searchParams.get("email") ?? "";
  const token = request.nextUrl.searchParams.get("token") ?? "";
  if (!email || !tokenMatches(email, token, env.authSecret)) {
    return new NextResponse("This unsubscribe link is invalid.", { status: 400 });
  }
  await suppressEmail(email, "unsubscribed");
  return new NextResponse("You have been unsubscribed and will not receive further emails.", { status: 200 });
}

export async function POST(request: NextRequest) {
  return GET(request);
}
