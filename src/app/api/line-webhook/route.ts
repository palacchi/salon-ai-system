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
const APPROVE_TRIGGER = "承認";
const REJECT_TRIGGER = "却下";

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

  // その人が送った一番新しい投稿を1件だけ見て、その状態に応じて処理を振り分ける。
  // (古い「承認待ち」が残っていても、新しい写真の会話を優先するため)
  const { data: post, error: findError } = await supabase
    .from("posts")
    .select("id, image_url, notes, status")
    .eq("line_user_id", lineUserId)
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

  if (post.status === "draft" || post.status === "needs_review") {
    await handleApprovalReply(event, post.id, text, lineUserId);
    return;
  }

  if (post.status === "generating") {
    if (event.replyToken) {
      await replyMessage(event.replyToken, "現在作成中です。少々お待ちください。");
    }
    return;
  }

  if (post.status !== "collecting") {
    if (event.replyToken) {
      await replyMessage(event.replyToken, "先に新しいスタイル写真を送ってください。");
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

    const { data: staffItems } = await supabase
      .from("staff")
      .select("name")
      .order("created_at", { ascending: true });

    const generated = await generatePostContent(
      post.image_url!,
      post.notes,
      menuItems ?? [],
      staffItems ?? []
    );
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

    const summary = formatPostSummary(generated);
    if (checkResult.flagged) {
      await pushMessage(
        lineUserId,
        `文章ができましたが、確認が必要な表現があります。\n${checkResult.issues.join("\n")}\n\n${summary}\n\n内容を確認し、問題なければ「承認」、やり直す場合は「却下」と送ってください。`
      );
    } else {
      await pushMessage(
        lineUserId,
        `スタイル投稿の文章ができました。\n\n${summary}\n\n内容を確認し、問題なければ「承認」、やり直す場合は「却下」と送ってください。`
      );
    }
  } catch (err) {
    console.error("AI生成に失敗しました", err);
    await supabase.from("posts").update({ status: "collecting" }).eq("id", post.id);
    await pushMessage(lineUserId, "文章の作成中にエラーが発生しました。もう一度「OK」と送ってください。");
  }
}

async function handleApprovalReply(
  event: TextMessageEvent,
  postId: string,
  text: string,
  lineUserId: string
) {
  const trimmed = text.trim();

  if (trimmed === APPROVE_TRIGGER) {
    const { error: updateError } = await supabase
      .from("posts")
      .update({ status: "approved" })
      .eq("id", postId);

    if (updateError) {
      console.error("承認の保存に失敗しました", updateError.message);
      return;
    }

    await supabase.from("approval_logs").insert({
      target_type: "post",
      target_id: postId,
      action: "approved",
      approved_by: lineUserId,
    });

    if (event.replyToken) {
      await replyMessage(event.replyToken, "承認しました。ありがとうございます。");
    }
    return;
  }

  if (trimmed === REJECT_TRIGGER) {
    const { error: updateError } = await supabase
      .from("posts")
      .update({ status: "rejected" })
      .eq("id", postId);

    if (updateError) {
      console.error("却下の保存に失敗しました", updateError.message);
      return;
    }

    await supabase.from("approval_logs").insert({
      target_type: "post",
      target_id: postId,
      action: "rejected",
      approved_by: lineUserId,
    });

    if (event.replyToken) {
      await replyMessage(
        event.replyToken,
        "却下しました。やり直す場合は、新しいスタイル写真から送ってください。"
      );
    }
    return;
  }

  if (event.replyToken) {
    await replyMessage(
      event.replyToken,
      "内容を確認し、問題なければ「承認」、やり直す場合は「却下」と送ってください。"
    );
  }
}

function formatPostSummary(content: GeneratedContent): string {
  const price = content.price != null ? `${content.price}円` : "未入力";
  return [
    `■ブログタイトル\n${content.blog_title}`,
    `■ブログ本文\n${content.blog_body}`,
    `■担当スタイリスト\n${content.stylist_name}`,
    `■スタイル名\n${content.style_name}`,
    `■コメント\n${content.style_description}`,
    `■カテゴリ\n${content.category}`,
    `■長さ\n${content.hair_length}`,
    `■おすすめ年代\n${content.recommended_age}`,
    `■カラー\n${content.hair_color}`,
    `■メニュー\n${content.menu_text}`,
    `■料金\n${price}`,
    `■スタイリング方法\n${content.styling_method}`,
    `■Instagram投稿文\n${content.instagram_text}`,
    `■Google投稿文\n${content.google_text}`,
    `■LINE配信文\n${content.line_text}`,
  ].join("\n\n");
}

const GENERATED_FIELDS = [
  "blog_title",
  "blog_body",
  "stylist_name",
  "style_name",
  "style_description",
  "category",
  "hair_length",
  "recommended_age",
  "hair_color",
  "menu_text",
  "price",
  "styling_method",
  "instagram_text",
  "google_text",
  "line_text",
] as const;

type GeneratedContent = Record<(typeof GENERATED_FIELDS)[number], string | number | null>;

async function generatePostContent(
  imageUrl: string,
  notes: string | null,
  menuItems: { name: string; price: number | null }[],
  staffItems: { name: string }[]
): Promise<GeneratedContent> {
  const systemPrompt = `あなたは美容室のSNS・ブログ運用を担当する、経験豊富な人間のコピーライターです。
写真と担当者からのメモをもとに、実際にお客様が読んで来店したくなるような、自然で温かみのある文章を作成してください。
生成した内容はSALON BOARD(HOT PEPPER Beautyのサロン管理画面)にそのまま登録するため、下記の文字数制限・選択肢を必ず守ってください。

必ず守るルール:
- 機械的・定型的な言い回しを避け、人間が書いたような自然な日本語にする
- 絵文字(😊✨💇‍♀️など)と顔文字((^^)/、(◍•ᴗ•◍)、(*'▽')など)の両方を、blog_body・instagram_text・google_text・line_textの各文章に最低1つずつは使い、楽しく親しみやすい雰囲気を出す。ただし使いすぎず、丁寧な言葉遣いは崩さない
- style_descriptionは、SALON BOARDのコメント欄にそのまま登録されるため絵文字(😊✨💇‍♀️など)は一切使わない。顔文字((^^)/、(◍•ᴗ•◍)、(*'▽')など、通常の文字だけで書けるもの)は使ってよい
- style_name・category・hair_length・recommended_age・menu_text・stylist_nameには絵文字・顔文字を付けない
- Instagram投稿文・LINE配信文は特に絵文字・顔文字を多めに、明るく楽しい雰囲気にする
- ブログ本文・Google投稿文は、楽しさを出しつつも、お店の説明として丁寧で読みやすい文章にする
- 誇大表現(「必ず」「絶対」「日本一」など)は使わない
- 医療的な効果効能を断定しない(「発毛する」「薄毛が治る」など)
- メニュー名・料金は、下に渡す「実際のメニュー一覧」の中から、写真とメモに最も近いものを選んで使う。一覧に無い名前や料金を勝手に作らない
- 一覧の中に近いものが無い場合は、menu_textに「未入力」と書き、priceはnullにする
- スタイリスト名は、下に渡す「実際のスタイリスト一覧」の中から、メモに書かれた担当者名に最も近いものを1つ選ぶ。メモに担当者名が無い、または一覧の中に該当者がいない場合は「PALACCHI スタッフ」を選ぶ
- style_nameは30文字以内で簡潔に
- style_descriptionは120文字以内
- menu_textは50文字以内
- categoryは写真から判断してレディースかメンズのどちらか1つを選ぶ
- hair_lengthは、categoryがレディースなら「ベリーショート/ショート/ミディアム/セミロング/ロング/ヘアセット/ミセス」の中から、メンズなら「ボウズ/ベリーショート/ショート/ミディアム/ロング/その他」の中から、写真に最も近いものを1つ選ぶ
- recommended_ageは特定の年代に絞らず、常に「設定しない」にする
- 写真から読み取れないことを断定的に書かない`;

  const menuList = menuItems.length
    ? menuItems.map((m) => `- ${m.name}(${m.price ?? "料金未設定"}円)`).join("\n")
    : "(メニュー一覧が登録されていません)";

  const staffList = staffItems.length
    ? staffItems.map((s) => `- ${s.name}`).join("\n")
    : "(スタイリスト一覧が登録されていません)";

  const userText = `【実際のメニュー一覧】
${menuList}

【実際のスタイリスト一覧】
${staffList}

【担当者からのメモ】
${notes && notes.trim() ? notes : "(メモなし)"}

上の写真・メモ・メニュー一覧・スタイリスト一覧をもとに、次の${GENERATED_FIELDS.length}項目をすべて日本語で作成してください。`;

  const schema = {
    type: "object" as const,
    properties: {
      blog_title: { type: "string", description: "HOT PEPPER Beautyのブログタイトル。30〜40文字程度" },
      blog_body: { type: "string", description: "HOT PEPPER Beautyのブログ本文。300〜600文字程度の自然な文章" },
      stylist_name: {
        type: "string",
        enum: staffItems.length ? staffItems.map((s) => s.name) : ["PALACCHI スタッフ"],
        description: "実際のスタイリスト一覧の中から1つ選ぶ",
      },
      style_name: { type: "string", maxLength: 30, description: "スタイル名。30文字以内" },
      style_description: {
        type: "string",
        maxLength: 120,
        description: "スタイルの説明(コメント)。120文字以内。絵文字は使わない(SALON BOARDのコメント欄で使用不可のため)",
      },
      category: { type: "string", enum: ["レディース", "メンズ"], description: "写真から判断する" },
      hair_length: {
        type: "string",
        enum: ["ベリーショート", "ショート", "ミディアム", "セミロング", "ロング", "ヘアセット", "ミセス", "ボウズ", "その他"],
        description: "categoryに応じた選択肢の中から1つ選ぶ",
      },
      recommended_age: {
        type: "string",
        enum: ["設定しない"],
        description: "常に「設定しない」",
      },
      hair_color: { type: "string", description: "カラーの説明" },
      menu_text: { type: "string", maxLength: 50, description: "メニュー名。50文字以内。メモに無ければ「未入力」" },
      price: {
        type: ["integer", "null"],
        description: "料金(円)。カンマや「円」は付けず数字のみ。例: 12000。一覧に一致するものが無ければnull",
      },
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
