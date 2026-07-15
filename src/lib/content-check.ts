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

export function checkGeneratedContent(content: ContentCheckTarget): ContentCheckResult {
  const issues: string[] = [];

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
