import { chromium } from "playwright";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

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

async function main() {
  console.log("ブラウザを起動しています(画面表示あり)...");
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

  try {
    console.log("SALON BOARDのログイン画面に接続しています...");
    await page.goto("https://salonboard.com/login/", { waitUntil: "domcontentloaded", timeout: 20000 });
    console.log("接続に成功しました！ページタイトル:", await page.title());

    await page.locator('input[type="text"]').first().fill(env.SALON_BOARD_LOGIN_ID ?? "");
    await page.locator('input[type="password"]').first().fill(env.SALON_BOARD_PASSWORD ?? "");
    console.log("ID・パスワードを入力しました(まだログインボタンは押していません)");

    const screenshotPath = path.join(scriptDir, "test-connection-result.png");
    await page.screenshot({ path: screenshotPath });
    console.log("スクリーンショットを保存しました:", screenshotPath);
    console.log("\n=== 結果: 成功 ===");
  } catch (err) {
    console.error("\n=== 結果: 失敗 ===");
    console.error(err instanceof Error ? err.message : err);
    try {
      const screenshotPath = path.join(scriptDir, "test-connection-error.png");
      await page.screenshot({ path: screenshotPath });
      console.log("エラー時点のスクリーンショットを保存しました:", screenshotPath);
    } catch {
      // ignore
    }
  } finally {
    await browser.close();
  }
}

main();
