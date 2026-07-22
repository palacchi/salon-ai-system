const EXAGGERATION_WORDS = [
  "絶対",
  "必ず",
  "100%",
  "100パーセント",
  "完全に",
  "日本一",
  "業界No.1",
  "業界no.1",
  "永久に",
  "誰でも",
  "確実に",
  "最高峰",
  "No.1",
];

const MEDICAL_CLAIM_WORDS = [
  "発毛",
  "育毛",
  "治る",
  "治療",
  "薬用効果",
  "副作用がない",
  "医学的に証明",
  "薄毛が治",
];

const CHECK_FIELDS = [
  "blog_title",
  "blog_body",
  "style_description",
  "instagram_text",
  "google_text",
  "line_text",
] as const;

export type ContentCheckTarget = Record<string, string | number | null>;

export type ContentCheckResult = {
  flagged: boolean;
  issues: string[];
};

const FEMALE_HAIR_LENGTHS = ["ベリーショート", "ショート", "ミディアム", "セミロング", "ロング", "ヘアセット", "ミセス"];
const MALE_HAIR_LENGTHS = ["ボウズ", "ベリーショート", "ショート", "ミディアム", "ロング", "その他"];

const SALON_BOARD_LENGTH_LIMITS: Record<string, number> = {
  style_name: 30,
  style_description: 120,
  menu_text: 50,
};

const EMOJI_REGEX = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}️]/u;

export function checkGeneratedContent(content: ContentCheckTarget): ContentCheckResult {
  const issues: string[] = [];

  for (const [field, limit] of Object.entries(SALON_BOARD_LENGTH_LIMITS)) {
    const value = content[field];
    if (typeof value === "string" && value.length > limit) {
      issues.push(`${field}がSALON BOARDの文字数上限(${limit}文字)を超えています(現在${value.length}文字)`);
    }
  }

  const styleDescription = content.style_description;
  if (typeof styleDescription === "string" && EMOJI_REGEX.test(styleDescription)) {
    issues.push("style_descriptionに絵文字が含まれています(SALON BOARDのコメント欄では使用できません)");
  }

  const category = content.category;
  const hairLength = content.hair_length;
  if (typeof category === "string" && typeof hairLength === "string") {
    const validLengths = category === "メンズ" ? MALE_HAIR_LENGTHS : FEMALE_HAIR_LENGTHS;
    if (!validLengths.includes(hairLength)) {
      issues.push(`categoryが「${category}」なのにhair_lengthが「${hairLength}」で、SALON BOARDの選択肢と合っていません`);
    }
  }

  for (const field of CHECK_FIELDS) {
    const value = content[field];
    if (typeof value !== "string") continue;

    for (const word of EXAGGERATION_WORDS) {
      if (value.includes(word)) {
        issues.push(`${field}に誇大表現の可能性がある言葉「${word}」があります`);
      }
    }

    for (const word of MEDICAL_CLAIM_WORDS) {
      if (value.includes(word)) {
        issues.push(`${field}に医療効果の断定の可能性がある言葉「${word}」があります`);
      }
    }
  }

  const blogBody = content.blog_body;
  if (typeof blogBody === "string") {
    const duplicate = findDuplicateSentence(blogBody);
    if (duplicate) {
      issues.push(`blog_bodyに同じ文が繰り返されています:「${duplicate}」`);
    }
  }

  return { flagged: issues.length > 0, issues };
}

function findDuplicateSentence(text: string): string | null {
  const sentences = text
    .split(/[。\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);

  const seen = new Set<string>();
  for (const sentence of sentences) {
    if (seen.has(sentence)) {
      return sentence;
    }
    seen.add(sentence);
  }
  return null;
}
