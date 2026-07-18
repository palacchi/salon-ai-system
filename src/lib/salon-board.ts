import chromium from "@sparticuz/chromium";
import { chromium as playwrightChromium, type Page } from "playwright-core";

const SALON_BOARD_LOGIN_ID = process.env.SALON_BOARD_LOGIN_ID!;
const SALON_BOARD_PASSWORD = process.env.SALON_BOARD_PASSWORD!;
const BROWSERLESS_API_KEY = process.env.BROWSERLESS_API_KEY;

const NISHINOMIYA_SALON_NAME = "髪質改善サロン Palacchi 西宮店【パラッチ】";

const CATEGORY_CODES: Record<"レディース" | "メンズ", string> = {
  レディース: "SG01",
  メンズ: "SG02",
};

const FEMALE_LENGTH_CODES: Record<string, string> = {
  ベリーショート: "HL05",
  ショート: "HL04",
  ミディアム: "HL03",
  セミロング: "HL02",
  ロング: "HL01",
  ヘアセット: "HL08",
  ミセス: "HL07",
};

const MALE_LENGTH_CODES: Record<string, string> = {
  ボウズ: "HL09",
  ベリーショート: "HL10",
  ショート: "HL11",
  ミディアム: "HL12",
  ロング: "HL13",
  その他: "HL06",
};

export type SalonBoardStyleInput = {
  imageUrl: string;
  stylistValue: string;
  styleName: string;
  comment: string;
  category: "レディース" | "メンズ";
  hairLength: string;
  menuText: string;
  couponId: string | null;
};

export type SalonBoardFillResult =
  | { ok: true; screenshotBase64: string }
  | { ok: false; reason: string; screenshotBase64?: string };

function resolveHairLengthCode(category: "レディース" | "メンズ", hairLength: string): string | null {
  const table = category === "メンズ" ? MALE_LENGTH_CODES : FEMALE_LENGTH_CODES;
  return table[hairLength] ?? null;
}

async function fillFieldAfterLabel(page: Page, labelText: string, tag: "textarea" | "input", value: string) {
  const field = page.locator(`xpath=//*[contains(text(), "${labelText}")]/following::${tag}[1]`).first();
  await field.fill(value);
}

async function launchBrowser() {
  if (BROWSERLESS_API_KEY) {
    return playwrightChromium.connectOverCDP(
      `wss://production-sfo.browserless.io?token=${BROWSERLESS_API_KEY}&proxy=residential&proxyCountry=jp&proxySticky=true&proxyLocaleMatch=true`
    );
  }
  return playwrightChromium.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: true,
  });
}

export async function fillSalonBoardStyleForm(input: SalonBoardStyleInput): Promise<SalonBoardFillResult> {
  const hairLengthCode = resolveHairLengthCode(input.category, input.hairLength);
  if (!hairLengthCode) {
    return { ok: false, reason: `長さ「${input.hairLength}」がcategory「${input.category}」の選択肢にありません` };
  }

  const startedAt = Date.now();
  const log = (step: string) => console.log(`[salon-board] ${step} (${Date.now() - startedAt}ms)`);

  const browser = await launchBrowser();
  log("browser launched");
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

  try {
    const imageResPromise = fetch(input.imageUrl);

    await page.goto("https://salonboard.com/login/", { waitUntil: "domcontentloaded", timeout: 20000 });
    log("login page loaded");
    await page.locator('input[type="text"]').first().fill(SALON_BOARD_LOGIN_ID);
    await page.locator('input[type="password"]').first().fill(SALON_BOARD_PASSWORD);
    await page.getByRole("link", { name: "ログイン", exact: true }).click();
    await page.waitForLoadState("domcontentloaded");
    log("logged in");

    const salonLink = page.getByText(NISHINOMIYA_SALON_NAME, { exact: true });
    if ((await salonLink.count()) > 0) {
      await salonLink.first().click();
      await page.waitForLoadState("domcontentloaded");
      log("salon selected");
    }

    await page.goto("https://salonboard.com/CNB/draft/styleList/", { waitUntil: "domcontentloaded" });
    log("style list loaded");
    await page.locator('img[alt="スタイル新規追加"]').click();
    await page.waitForSelector("text=スタイル掲載情報編集");
    log("new style form loaded");

    const imageRes = await imageResPromise;
    if (!imageRes.ok) {
      return { ok: false, reason: `写真のダウンロードに失敗しました(status: ${imageRes.status})` };
    }
    const imageBuffer = Buffer.from(await imageRes.arrayBuffer());
    log("image downloaded");
    await page
      .locator('input[type="file"]')
      .first()
      .setInputFiles({ name: "style.jpg", mimeType: "image/jpeg", buffer: imageBuffer });
    await page.waitForTimeout(1500);
    log("image uploaded");

    const stylistSelect = page.locator(`select:has(option[value="${input.stylistValue}"])`).first();
    await stylistSelect.selectOption(input.stylistValue);

    await fillFieldAfterLabel(page, "コメント", "textarea", input.comment);
    await fillFieldAfterLabel(page, "スタイル名", "input", input.styleName);

    await page.locator(`input[type="radio"][value="${CATEGORY_CODES[input.category]}"]`).click();

    const lengthSelect = page.locator(`select:has(option[value="${hairLengthCode}"])`).first();
    await lengthSelect.selectOption(hairLengthCode);

    await fillFieldAfterLabel(page, "メニュー内容", "textarea", input.menuText);
    log("basic fields filled");

    if (input.couponId) {
      await page.locator('img[alt="クーポン選択"]').click();
      await page.waitForSelector(`input[type="radio"][value="${input.couponId}"]`);
      await page.locator(`input[type="radio"][value="${input.couponId}"]`).click();
      const confirmButton = page.getByRole("button", { name: /設定/ }).or(page.getByRole("link", { name: /設定/ }));
      if ((await confirmButton.count()) > 0) {
        await confirmButton.first().click();
        await page.waitForTimeout(300);
      }
      log("coupon selected");
    }

    const screenshotBuffer = await page.screenshot({ fullPage: true });
    log("screenshot taken");
    return { ok: true, screenshotBase64: screenshotBuffer.toString("base64") };
  } catch (err) {
    const screenshotBuffer = await page.screenshot({ fullPage: true }).catch(() => null);
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "不明なエラーが発生しました",
      screenshotBase64: screenshotBuffer ? screenshotBuffer.toString("base64") : undefined,
    };
  } finally {
    await browser.close();
  }
}
