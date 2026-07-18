import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { fillSalonBoardStyleForm } from "@/lib/salon-board";

export const maxDuration = 60;

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const TEST_SECRET = process.env.LINE_CHANNEL_SECRET!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

export async function POST(req: NextRequest) {
  if (req.headers.get("x-test-secret") !== TEST_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json()) as { postId?: string };
  if (!body.postId) {
    return NextResponse.json({ error: "postId is required" }, { status: 400 });
  }

  const { data: post, error: postError } = await supabase
    .from("posts")
    .select("image_url, stylist_name, style_name, style_description, category, hair_length, menu_text")
    .eq("id", body.postId)
    .maybeSingle();

  if (postError || !post) {
    return NextResponse.json({ error: postError?.message ?? "post not found" }, { status: 404 });
  }
  if (
    !post.image_url ||
    !post.stylist_name ||
    !post.style_name ||
    !post.style_description ||
    !post.category ||
    !post.hair_length ||
    !post.menu_text
  ) {
    return NextResponse.json({ error: "post is missing required generated fields" }, { status: 400 });
  }

  const { data: staff } = await supabase
    .from("staff")
    .select("salon_board_value")
    .eq("name", post.stylist_name)
    .maybeSingle();

  if (!staff?.salon_board_value) {
    return NextResponse.json({ error: `stylist not found: ${post.stylist_name}` }, { status: 400 });
  }

  let couponId: string | null = null;
  if (post.menu_text !== "未入力") {
    const { data: menu } = await supabase
      .from("menu")
      .select("salon_board_coupon_id")
      .eq("name", post.menu_text)
      .maybeSingle();
    if (!menu?.salon_board_coupon_id) {
      return NextResponse.json({ error: `coupon not found for menu: ${post.menu_text}` }, { status: 400 });
    }
    couponId = menu.salon_board_coupon_id;
  }

  const result = await fillSalonBoardStyleForm({
    imageUrl: post.image_url,
    stylistValue: staff.salon_board_value,
    styleName: post.style_name,
    comment: post.style_description,
    category: post.category as "レディース" | "メンズ",
    hairLength: post.hair_length,
    menuText: post.menu_text,
    couponId,
  });

  return NextResponse.json(result);
}
