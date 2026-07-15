import { NextRequest, NextResponse } from "next/server";
import { validateSignature, webhook } from "@line/bot-sdk";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { checkGeneratedContent } from "@/lib/content-check";

export const maxDuration = 60;

type ImageMessageEvent = webhook.MessageEvent & { message: webhook.ImageMessageContent };
type TextMessageEvent = webhook.MessageEvent & { message: webhook.TextMessageContent };

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET!;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN!;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const GENERATION_TRIGGER = "ok";

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
    } else if (event.type === "message" && event.message.type === "text") {
      await handleTextMessage(event as TextMessageEvent);
    }
  }

  return NextResponse.json({ ok: true });
}

async function handleImageMessage(event: ImageMessageEvent) {
  const messageId = event.message.id;
  const lineUserId = event.source?.userId;

  if (!lineUserId) return;

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
    status: "collecting",
    line_user_id: lineUserId,
  });

  if (insertError) {
    console.error("投稿データの保存に失敗しました", insertError.message);
    return;
  }

  if (event.replyToken) {
    await replyMessage(
      event.replyToken,
      "写真を受け取りました。担当者・メニュー・料金・特徴などがあれば送ってください。\n無ければ「OK」と送ってください。"
    );
  }
}

async function handleTextMessage(event: TextMessageEvent) {
  const lineUserId = event.source?.userId;
  const text = event.message.text;

  if (!lineUserId) return;

  const { data: post, error: findError } = await supabase
    .from("posts")
    .select("id, image_url, notes")
    .eq("line_user_id", lineUserId)
    .eq("status", "collecting")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (findError) {
    console.error("投稿データの取得に失敗しました", findError.message);
    return;
  }

  if (!post) {
    if (event.replyToken) {
      await replyMessage(event.replyToken, "先にスタイル写真を送ってください。");
    }
    return;
  }

  const isTrigger = text.trim().toLowerCase() === GENERATION_TRIGGER;

  if (!isTrigger) {
    const updatedNotes = post.notes ? `${post.notes}\n${text}` : text;
    const { error: updateError } = await supabase
      .from("posts")
      .update({ notes: updatedNotes })
      .eq("id", post.id);

    if (updateError) {
      console.error("メモの保存に失敗しました", updateError.message);
      return;
    }

    if (event.replyToken) {
      await replyMessage(
        event.replyToken,
        "受け取りました。他にあれば送ってください。\n無ければ「OK」と送ってください。"
      );
    }
    return;
  }

  if (event.replyToken) {
    await replyMessage(event.replyToken, "作成中です。少々お待ちください。");
  }

  await supabase.from("posts").update({ status: "generating" }).eq("id", post.id);

  try {
    const { data: menuItems } = await supabase
      .from("menu")
      .select("name, price")
      .order("created_at", { ascending: true });

    const generated = await generatePostContent(post.image_url!, post.notes, menuItems ?? []);
    const checkResult = checkGeneratedContent(generated);

    const { error: updateError } = await supabase
      .from("posts")
      .update({
        ...generated,
        status: checkResult.flagged ? "needs_review" : "draft",
        review_flags: checkResult.flagged ? checkResult.issues.join("\n") : null,
      })
      .eq("id", post.id);

    if (updateError) {
      console.error("生成結果の保存に失敗しました", updateError.message);
      await pushMessage(lineUserId, "文章の保存中にエラーが発生しました。");
      return;
    }

    if (checkResult.flagged) {
      await pushMessage(
        lineUserId,
        `文章ができましたが、確認が必要な表現があります。\n${checkResult.issues.join("\n")}\n内容を確認・修正してください。`
      );
    } else {
      await pushMessage(lineUserId, "スタイル投稿の文章ができました。内容を確認してください。");
    }
  } catch (err) {
    console.error("AI生成に失敗しました", err);
    await supabase.from("posts").update({ status: "collecting" }).eq("id", post.id);
    await pushMessage(lineUserId, "文章の作成中にエラーが発生しました。もう一度「OK」と送ってください。");
  }
}

const GENERATED_FIELDS = [
  "blog_title",
  "blog_body",
  "style_name",
  "style_description",
  "recommended_age",
  "hair_length",
  "hair_color",
  "menu_text",
  "price",
  "styling_method",
  "instagram_text",
  "google_text",
  "line_text",
] as const;

type GeneratedContent = Record<(typeof GENERATED_FIELDS)[number], string | number>;

async function generatePostContent(
  imageUrl: string,
  notes: string | null,
  menuItems: { name: string; price: number | null }[]
): Promise<GeneratedContent> {
  const systemPrompt = `あなたは美容室のSNS・ブログ運用を担当する、経験豊富な人間のコピーライターです。
写真と担当者からのメモをもとに、実際にお客様が読んで来店したくなるような、自然で温かみのある文章を作成してください。

必ず守るルール:
- 機械的・定型的な言い回しを避け、人間が書いたような自然な日本語にする
- 誇大表現(「必ず」「絶対」「日本一」など)は使わない
- 医療的な効果効能を断定しない(「発毛する」「薄毛が治る」など)
- メニュー名・料金は、下に渡す「実際のメニュー一覧」の中から、写真とメモに最も近いものを選んで使う。一覧に無い名前や料金を勝手に作らない
- 一覧の中に近いものが無い場合は、そのフィールドに「未入力」と書く
- 写真から読み取れないことを断定的に書かない`;

  const menuList = menuItems.length
    ? menuItems.map((m) => `- ${m.name}(${m.price ?? "料金未設定"}円)`).join("\n")
    : "(メニュー一覧が登録されていません)";

  const userText = `【実際のメニュー一覧】
${menuList}

【担当者からのメモ】
${notes && notes.trim() ? notes : "(メモなし)"}

上の写真・メモ・メニュー一覧をもとに、次の13項目をすべて日本語で作成してください。`;

  const schema = {
    type: "object" as const,
    properties: {
      blog_title: { type: "string", description: "HOT PEPPER Beautyのブログタイトル。30〜40文字程度" },
      blog_body: { type: "string", description: "HOT PEPPER Beautyのブログ本文。300〜600文字程度の自然な文章" },
      style_name: { type: "string", description: "スタイル名" },
      style_description: { type: "string", description: "スタイルの説明。100〜200文字程度" },
      recommended_age: { type: "string", description: "例: 20代〜30代" },
      hair_length: { type: "string", description: "例: ショート、ボブ、ミディアム、ロング" },
      hair_color: { type: "string", description: "カラーの説明" },
      menu_text: { type: "string", description: "メニュー名。メモに無ければ「未入力」" },
      price: { type: "string", description: "料金。例: 12,000円。メモに無ければ「未入力」" },
      styling_method: { type: "string", description: "おうちでのスタイリング方法" },
      instagram_text: { type: "string", description: "ハッシュタグを含むInstagram投稿文" },
      google_text: { type: "string", description: "Google Business Profileへの投稿文" },
      line_text: { type: "string", description: "お客様へのLINE配信用の短い文章" },
    },
    required: [...GENERATED_FIELDS],
    additionalProperties: false,
  };

  const response = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 4096,
    system: systemPrompt,
    output_config: {
      format: { type: "json_schema", schema },
    },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "url", url: imageUrl } },
          { type: "text", text: userText },
        ],
      },
    ],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("AIから文章が返されませんでした");
  }

  return JSON.parse(textBlock.text) as GeneratedContent;
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

async function pushMessage(userId: string, text: string) {
  await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      to: userId,
      messages: [{ type: "text", text }],
    }),
  });
}
