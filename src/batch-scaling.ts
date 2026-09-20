/**
 * 實驗：一個 request 裡塞多少筆交易，分類才會開始變差？
 *
 *   NODE_USE_ENV_PROXY=1 node src/batch-scaling.ts
 *
 * `src/batch-vs-single.ts` 顯示 12 筆批次與逐筆完全一致。
 * 但 jaggedness #5 說 state 變大會掉準度，所以這裡把批次規模拉上去，
 * 每個規模都跟「逐筆」的結果比對，看一致率何時開始下降。
 *
 * 逐筆結果視為基準（每題只看得到自己那筆，沒有其他筆的干擾）。
 */
import { TypeSafeClient, choice } from '@typesafe-ai/sdk';

const client = new TypeSafeClient({
  apiKey: process.env.TYPESAFE_API_KEY ?? 'placeholder-overridden-by-proxy',
  timeout: 120_000,
});

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

type Transaction = { date: string; merchant: string; amount: number };

const POOL = [
  '全聯福利中心', '星巴克', 'ANTHROPIC CLAUDE', '誠品書店', '屈臣氏', 'UBER TRIP',
  'momo購物網', '統一超商', '台灣中油', 'NETFLIX.COM', '長庚醫院掛號', '家樂福',
  '麥當勞', '台北捷運', 'SPOTIFY', '寶雅', '鼎泰豐', '博客來',
  'Google One', '康是美', '大潤發', '五十嵐', '台灣大車隊', '威秀影城',
];

/** 產生 n 筆交易，商家循環取用、金額與日期可重現。 */
function makeTransactions(n: number): Transaction[] {
  return Array.from({ length: n }, (_, i) => ({
    date: `2026-09-${String((i % 28) + 1).padStart(2, '0')}`,
    merchant: POOL[i % POOL.length]!,
    amount: 100 + ((i * 137) % 1900),
  }));
}

const ask = (i: number) =>
  choice(`\`transactions[${i}]\` 這筆消費應該記到哪一個帳目類別？`, RULES);

/** 基準：每筆一個 request，state 只含該筆。 */
async function perTransaction(txs: Transaction[]): Promise<string[]> {
  const out: string[] = [];
  for (const tx of txs) {
    const { answers } = await client.systemOne({
      state: { transactions: [tx] },
      questions: { c: ask(0) },
    });
    out.push(answers.c.choice);
  }
  return out;
}

/** 一個 request 包含全部。 */
async function batched(txs: Transaction[]) {
  const ids = txs.map((_, i) => `tx${i}`);
  const questions = Object.fromEntries(txs.map((_, i) => [ids[i]!, ask(i)]));
  const started = Date.now();
  const resp = await client.systemOne({ state: { transactions: txs }, questions });
  const picked = ids.map((id) => resp.answers[id] as { choice: string; confidence: number });
  return {
    labels: picked.map((a) => a.choice),
    confidences: picked.map((a) => a.confidence),
    tokens: resp.usage.input_tokens,
    ms: Date.now() - started,
  };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

const SIZES = [12, 18, 24, 30, 36, 48];

console.log('規模   批次tokens  耗時    與逐筆一致       平均conf  最常見標籤佔比');
console.log('─'.repeat(70));

for (const n of SIZES) {
  const txs = makeTransactions(n);
  const base = await perTransaction(txs);
  try {
    const b = await batched(txs);
    const same = base.filter((v, i) => v === b.labels[i]).length;
    // 塌陷偵測：若大量答案擠到同一個標籤，代表模型已經認不出是在問哪一筆
    const counts = new Map<string, number>();
    for (const l of b.labels) counts.set(l, (counts.get(l) ?? 0) + 1);
    const top = [...counts.entries()].sort((x, y) => y[1] - x[1])[0]!;
    console.log(
      `${String(n).padStart(3)}   ${String(b.tokens).padStart(7)} tok` +
        `${String(b.ms).padStart(7)} ms   ${String(same).padStart(3)}/${String(n).padEnd(3)}` +
        ` (${((same / n) * 100).toFixed(0).padStart(3)}%)      ` +
        `${mean(b.confidences).toFixed(2)}     ${top[0]} ${((top[1] / n) * 100).toFixed(0)}%`,
    );
  } catch (err) {
    console.log(`${String(n).padStart(3)}   失敗：${(err as Error).message}`);
  }
}
