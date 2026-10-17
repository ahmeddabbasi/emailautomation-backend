import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/server";
import { htmlToPlainText, renderTemplate, sanitizeEmailHtml, templateVariables } from "@/lib/template-render";
import { sendRawEmail } from "@/lib/sending";
import { chooseCampaignMailbox, sendWithMailbox } from "@/lib/mailboxes";
import { jsonError, handleRouteError } from "@/lib/api-helpers";

const schema = z.object({
  sequenceStep: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  name: z.string().default(""),
  subject: z.string().min(1),
  htmlBody: z.string().min(1),
  textBody: z.string().optional(),
});

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { data, error } = await supabaseAdmin().from("email_templates").select("id, name, sequence_step, subject, html_body, text_body").eq("campaign_id", id).order("sequence_step");
    if (error) throw new Error(error.message);
    return NextResponse.json({ templates: data ?? [] });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return jsonError(400, "Subject and HTML body are required");
    const html = sanitizeEmailHtml(parsed.data.htmlBody);
    if (/<script|javascript:/i.test(html)) return jsonError(400, "Templates cannot include scripts");
    const text = parsed.data.textBody?.trim() || htmlToPlainText(html);
    const { data, error } = await supabaseAdmin()
      .from("email_templates")
      .upsert(
        {
          campaign_id: id,
          sequence_step: parsed.data.sequenceStep,
          name: parsed.data.name,
          subject: parsed.data.subject,
          html_body: html,
          text_body: text,
        },
        { onConflict: "campaign_id,sequence_step" }
      )
      .select("id, name, sequence_step, subject, html_body, text_body")
      .single();
    if (error) throw new Error(error.message);
    return NextResponse.json({ template: data });
  } catch (err) {
    return handleRouteError(err);
  }
}

const previewSchema = schema.extend({
  sample: z.record(z.string(), z.string()).default({}),
  to: z.string().email().optional(),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const parsed = previewSchema.safeParse(await request.json());
    if (!parsed.success) return jsonError(400, "Invalid template preview");
    const vars = templateVariables({
      firstName: parsed.data.sample.first_name,
      lastName: parsed.data.sample.last_name,
      email: parsed.data.sample.email,
      company: parsed.data.sample.company,
      customFields: parsed.data.sample,
    });
    const subject = renderTemplate(parsed.data.subject, vars);
    const html = sanitizeEmailHtml(renderTemplate(parsed.data.htmlBody, vars));
    const text = renderTemplate(parsed.data.textBody?.trim() || htmlToPlainText(html), vars);
    if (!parsed.data.to) return NextResponse.json({ subject, html, text });

    const route = await chooseCampaignMailbox(id, "UTC");
    if (route.channel === "hold") return jsonError(400, route.reason);
    if (route.channel === "mailbox") {
      await sendWithMailbox(route.mailboxId, { to: parsed.data.to, subject, text, html });
    } else {
      await sendRawEmail(parsed.data.to, subject, text, { html });
    }
    return NextResponse.json({ subject, html, text, sent: true });
  } catch (err) {
    return handleRouteError(err, "sending");
  }
}
