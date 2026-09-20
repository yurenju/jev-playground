/**
 * 實驗 1：記帳分類。
 *
 *   NODE_USE_ENV_PROXY=1 node src/expense-category.ts
 *
 * 設計取捨：
 *   - 分類是「在互斥的帳目中擇一」→ Choice（相對），並帶一個 other 作為 no-match
 *   - 「描述不足以判斷、需要人工確認」是獨立成立的事 → 另用 Noul（絕對）
 *     這兩個問題不同：Choice 硬要選一個，Noul 才會誠實說「看不出來」
 *   - 金額放進 state 當背景，但不拿來問任何數值判斷（jaggedness #2：算術留在 code）
 */
import { TypeSafeClient, choice, noul } from '@typesafe-ai/sdk';

const client = new TypeSafeClient({
  apiKey: process.env.TYPESAFE_API_KEY ?? 'placeholder-overridden-by-proxy',
});

/** criteria 要描述具體情境，並寫出容易混淆的邊界（jaggedness #1）。 */
const CATEGORIES = {
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

const EXPENSES = [
  { merchant: '全聯福利中心', amount: 856, note: '' },
  { merchant: '星巴克', amount: 180, note: '' },
  { merchant: 'Anthropic', amount: 600, note: 'Claude Pro 月費' },
  { merchant: '誠品書店', amount: 1200, note: '' },
  { merchant: '屈臣氏', amount: 420, note: '' },
  { merchant: 'Uber', amount: 240, note: '' },
  { merchant: 'momo購物網', amount: 890, note: '電風扇' },
  { merchant: '7-11', amount: 65, note: '' },
] as const;

const REVIEW_THRESHOLD = 0.5;
/** 對照組：直接用 Choice 的 confidence 當「分布不夠集中就送審」的閘門。 */
const CONFIDENCE_THRESHOLD = 0.8;

console.log('商家              金額  分類            conf   需確認   用Noul      用confidence');
console.log('─'.repeat(84));

for (const expense of EXPENSES) {
  const { answers } = await client.systemOne({
    // 只送問題需要的欄位（jaggedness #5）
    state: { expense },
    questions: {
      category: choice(
        '這筆消費應該記到哪一個帳目類別？依據 `expense.merchant` 與 `expense.note`判斷用途。',
        CATEGORIES,
      ),
      // 絕對判斷：Choice 一定會選一個出來，這題才問得出「其實看不出來」
      ambiguous: noul(
        '`expense.merchant` 與 `expense.note` 提供的資訊，是否不足以判斷這筆消費的用途，需要人工確認？',
        {
          true: '同一個商家可能對應到多個不同的帳目類別，而描述沒有指出是哪一種。',
          false: '從商家名稱或備註就能合理判定用途。',
        },
      ),
    },
  });

  const { category, ambiguous } = answers;
  const byNoul = ambiguous.noul > REVIEW_THRESHOLD;
  const byConfidence = category.confidence < CONFIDENCE_THRESHOLD;
  const label = (review: boolean) => (review ? '待確認' : '自動歸帳');

  console.log(
    `${expense.merchant.padEnd(16)}${String(expense.amount).padStart(5)}  ` +
      `${category.choice.padEnd(14)} ${category.confidence.toFixed(2)}   ` +
      `${ambiguous.noul.toFixed(2)}   ${label(byNoul).padEnd(11)} ${label(byConfidence)}`,
  );
}
