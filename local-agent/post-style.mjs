import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { fillSalonBoardStyleForm } from "./salon-board.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(scriptDir, "..", ".env.local");
if (!existsSync(envPath)) {
  console.error("../.env.local が見つかりません。プロジェクトのルートフォルダに .env.local を作成してください。");
  process.exit(1);
}

const env = Object.fromEntries(
  readFileSync(envPath, "utf-8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const idx = l.indexOf("=");
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
    })
);

const postId = process.argv[2];
if (!postId) {
  console.error("使い方: node post-style.mjs <postId>");
  process.exit(1);
}

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  const { data: post, error: postError } = await supabase
    .from("posts")
    .select("image_url, stylist_name, style_name, style_description, category, hair_length, menu_text")
    .eq("id", postId)
    .maybeSingle();

  if (postError || !post) {
    console.error("投稿が見つかりません:", postError?.message ?? "not found");
    process.exit(1);
  }

  const missing = ["image_url", "stylist_name", "style_name", "style_description", "category", "hair_length", "menu_text"].filter(
    (key) => !post[key]
  );
  if (missing.length > 0) {
    console.error("必要な項目が未生成です:", missing.join(", "));
    process.exit(1);
  }

  const { data: staff } = await supabase
    .from("staff")
    .select("salon_board_value")
    .eq("name", post.stylist_name)
    .maybeSingle();

  if (!staff?.salon_board_value) {
    console.error(`スタイリストが見つかりません: ${post.stylist_name}`);
    process.exit(1);
  }

  let couponId = null;
  if (post.menu_text !== "未入力") {
    const { data: menu } = await supabase
      .from("menu")
      .select("salon_board_coupon_id")
      .eq("name", post.menu_text)
      .maybeSingle();
    if (!menu?.salon_board_coupon_id) {
      console.error(`クーポンが見つかりません: ${post.menu_text}`);
      process.exit(1);
    }
    couponId = menu.salon_board_coupon_id;
  }

  console.log("SALON BOARDへの入力を開始します(登録ボタンは押しません)...");
  const result = await fillSalonBoardStyleForm(
    {
      imageUrl: post.image_url,
      stylistValue: staff.salon_board_value,
      styleName: post.style_name,
      comment: post.style_description,
      category: post.category,
      hairLength: post.hair_length,
      menuText: post.menu_text,
      couponId,
    },
    { loginId: env.SALON_BOARD_LOGIN_ID, password: env.SALON_BOARD_PASSWORD }
  );

  if (result.screenshotBuffer) {
    const screenshotPath = path.join(scriptDir, "post-style-result.png");
    const { writeFileSync } = await import("fs");
    writeFileSync(screenshotPath, result.screenshotBuffer);
    console.log("スクリーンショットを保存しました:", screenshotPath);
  }

  if (result.ok) {
    console.log("\n=== 結果: 成功(入力のみ、登録は未実行) ===");
  } else {
    console.error("\n=== 結果: 失敗 ===");
    console.error(result.reason);
    process.exit(1);
  }
}

main();
