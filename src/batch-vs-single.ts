/**
 * 實驗：多筆交易要逐筆送，還是塞進同一個 request？
 *
 *   NODE_USE_ENV_PROXY=1 node src/batch-vs-single.ts
 *
 * 官方 parallel_questions cookbook 的結論（批次不影響答案、且大幅省錢）
 * 適用的形狀是「一份大文件 + N 個問題」—— 文件只付一次費。
 * 這裡的形狀不同：N 筆交易、每筆一題。批次時每一題都看得到全部交易，
 * 其他筆對該題而言是無關內容（jaggedness #5 context rot）。
 *
 * 比較三種策略的「分類是否一致」與「input token 成本」：
 *   A 逐筆：N 個 request，每個 state 只含該筆
 *   B 批次：1 個 request，state 含全部，N 題各自引用 `transactions[i]`
 *   C 批次＋規則放 state：同 B，但標籤描述移到 state，criteria 留 null 不重複
 */
import { TypeSafeClient, choice } from '@typesafe-ai/sdk';
import type { ChoiceCriteria } from '@typesafe-ai/sdk';

const client = new TypeSafeClient({
  apiKey: process.env.TYPESAFE_API_KEY ?? 'placeholder-overridden-by-proxy',
});

/** $ per 1M input tokens（jev-1.13，output 免費）。 */
const PRICE_PER_MTOK = 0.042;

const RULES = {
  dining: '在外用餐或飲料：餐廳、小吃、外送、手搖杯、咖啡店消費',
  groceries: '自家料理用的生鮮食材與食品：超市、量販店、菜市場買的菜肉蛋奶',
  household: '家庭日用與耐久品：衛生紙、清潔用品、鍋碗、家電、家具',
  transport: '交通：捷運公車、計程車、共乘、加油、停車、機票車票',
  health: '醫療與健康：看診、掛號費、藥品、保健食品、健身房',
  entertainment: '娛樂與社交：電影、展覽、遊戲、送禮、聚會分攤',
  subscription: '定期訂閱的服務：串流、軟體、雲端空間、會員月費',
  education: '學習：書籍、課程、教材、考試報名費',
  other: '以上皆不適用',
} as const;

/** 標籤相同但不附描述，描述改放 state（策略 C 用）。 */
const BARE_LABELS: ChoiceCriteria = Object.fromEntries(
  Object.keys(RULES).map((k) => [k, null]),
);

/**
 * 模擬從銀行 API 撈回來的原始交易。
 * 兩個型別上的坑：`as const` 產生的 readonly 陣列不符合 SDK 的 JsonValue；
 * 用 `interface` 宣告也不行（沒有隱含索引簽章），要用 `type`。
 */
type Transaction = { date: string; merchant: string; amount: number };
const TRANSACTIONS: Transaction[] = [
  { date: '2026-09-01', merchant: '全聯福利中心', amount: 856 },
  { date: '2026-09-02', merchant: '星巴克', amount: 180 },
  { date: '2026-09-03', merchant: 'ANTHROPIC CLAUDE', amount: 600 },
  { date: '2026-09-04', merchant: '誠品書店', amount: 1200 },
  { date: '2026-09-05', merchant: '屈臣氏', amount: 420 },
  { date: '2026-09-06', merchant: 'UBER TRIP', amount: 240 },
  { date: '2026-09-07', merchant: 'momo購物網', amount: 890 },
  { date: '2026-09-08', merchant: '統一超商', amount: 65 },
  { date: '2026-09-09', merchant: '台灣中油', amount: 1500 },
  { date: '2026-09-10', merchant: 'NETFLIX.COM', amount: 390 },
  { date: '2026-09-11', merchant: '長庚醫院掛號', amount: 150 },
  { date: '2026-09-12', merchant: '家樂福', amount: 2340 },
];

const ids = TRANSACTIONS.map((_, i) => `tx${i}`);
const cost = (tokens: number) => (tokens / 1_000_000) * PRICE_PER_MTOK;

// ── A. 逐筆：每個 request 的 state 只含該筆 ────────────────────────────
const tA = Date.now();
let tokensA = 0;
const resultA: string[] = [];
for (const tx of TRANSACTIONS) {
  const { answers, usage } = await client.systemOne({
    state: { transaction: tx },
    questions: { category: choice('這筆消費應該記到哪一個帳目類別？', RULES) },
  });
  tokensA += usage.input_tokens;
  resultA.push(answers.category.choice);
}
const msA = Date.now() - tA;

// ── B. 批次：一個 request，每題引用 `transactions[i]` ──────────────────
const tB = Date.now();
const questionsB = Object.fromEntries(
  TRANSACTIONS.map((_, i) => [
    ids[i]!,
    choice(`\`transactions[${i}]\` 這筆消費應該記到哪一個帳目類別？`, RULES),
  ]),
);
const respB = await client.systemOne({ state: { transactions: TRANSACTIONS }, questions: questionsB });
const msB = Date.now() - tB;
const resultB = ids.map((id) => (respB.answers[id] as { choice: string }).choice);

// ── C. 批次＋規則放 state，criteria 不重複 ────────────────────────────
const tC = Date.now();
const questionsC = Object.fromEntries(
  TRANSACTIONS.map((_, i) => [
    ids[i]!,
    choice(
      `依照 \`rules\` 的定義，\`transactions[${i}]\` 這筆消費應該記到哪一個帳目類別？`,
      BARE_LABELS,
    ),
  ]),
);
const respC = await client.systemOne({
  state: { rules: RULES, transactions: TRANSACTIONS },
  questions: questionsC,
});
const msC = Date.now() - tC;
const resultC = ids.map((id) => (respC.answers[id] as { choice: string }).choice);

// ── 比較 ──────────────────────────────────────────────────────────────
console.log('商家                 A逐筆          B批次          C批次+規則在state');
console.log('─'.repeat(76));
for (const [i, tx] of TRANSACTIONS.entries()) {
  const [a, b, c] = [resultA[i]!, resultB[i]!, resultC[i]!];
  const flag = a === b && b === c ? '' : '  ← 不一致';
  console.log(`${tx.merchant.padEnd(20)} ${a.padEnd(14)} ${b.padEnd(14)} ${c.padEnd(14)}${flag}`);
}

const agree = (x: string[], y: string[]) => x.filter((v, i) => v === y[i]).length;
const row = (name: string, tokens: number, ms: number, same: number) =>
  `${name.padEnd(22)} ${String(tokens).padStart(6)} tok  $${cost(tokens).toFixed(6)}  ` +
  `${String(ms).padStart(6)} ms  與A一致 ${same}/${TRANSACTIONS.length}`;

console.log('\n' + '─'.repeat(76));
console.log(row('A 逐筆（12 requests）', tokensA, msA, TRANSACTIONS.length));
console.log(row('B 批次（1 request）', respB.usage.input_tokens, msB, agree(resultA, resultB)));
console.log(row('C 批次+規則在 state', respC.usage.input_tokens, msC, agree(resultA, resultC)));
console.log(`\n換算每 1000 筆：A $${(cost(tokensA) / 12 * 1000).toFixed(4)}` +
  ` ｜ B $${(cost(respB.usage.input_tokens) / 12 * 1000).toFixed(4)}` +
  ` ｜ C $${(cost(respC.usage.input_tokens) / 12 * 1000).toFixed(4)}`);
