import { NextRequest, NextResponse } from "next/server";
import { validateSignature, webhook } from "@line/bot-sdk";
import { createClient } from "@supabase/supabase-js";

type ImageMessageEvent = webhook.MessageEvent & { message: webhook.ImageMessageContent };

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET!;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN!;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature = req.headers.get("x-line-signature") ?? "";

  if (!validateSignature(rawBody, LINE_CHANNEL_SECRET, signature)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  const body = JSON.parse(rawBody) as webhook.CallbackRequest;

  for (const event of body.events) {
    if (event.type === "message" && event.message.type === "image") {
      await handleImageMessage(event as ImageMessageEvent);
    }
  }

  return NextResponse.json({ ok: true });
}

async function handleImageMessage(event: ImageMessageEvent) {
  const messageId = event.message.id;

  const contentRes = await fetch(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    { headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` } }
  );

  if (!contentRes.ok) {
    console.error("LINEから画像の取得に失敗しました", contentRes.status);
    return;
  }

  const imageBuffer = Buffer.from(await contentRes.arrayBuffer());
  const filePath = `${messageId}.jpg`;

  const { error: uploadError } = await supabase.storage
    .from("style-photos")
    .upload(filePath, imageBuffer, { contentType: "image/jpeg" });

  if (uploadError) {
    console.error("Supabaseへの画像保存に失敗しました", uploadError.message);
    return;
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from("style-photos").getPublicUrl(filePath);

  const { error: insertError } = await supabase.from("posts").insert({
    image_url: publicUrl,
    status: "draft",
  });

  if (insertError) {
    console.error("投稿データの保存に失敗しました", insertError.message);
    return;
  }

  if (event.replyToken) {
    await replyMessage(event.replyToken, "写真を受け取りました。ありがとうございます。");
  }
}

async function replyMessage(replyToken: string, text: string) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });
}
