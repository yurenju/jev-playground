/**
 * 實驗：同一組標籤，用一個 Choice 問 vs 每個標籤各問一個 Noul。
 *
 *   NODE_USE_ENV_PROXY=1 node src/choice-vs-noul.ts
 *
 * 想驗證 jev-1.13 jaggedness 第 8 項「結構不變式不保證」：
 *   - Choice 是相對的：在選項之間分配機率，總和為 1，回答「是哪一個」
 *   - Noul 是絕對的：各自獨立，總和不必為 1，可以全高或全低
 * 所以在 Noul 上調出來的門檻不能直接搬去用在 Choice 上，反之亦然。
 * https://docs.typesafe.ai/model-jaggedness/jev-1.13.md
 */
import { TypeSafeClient, choice, noul } from '@typesafe-ai/sdk';

const client = new TypeSafeClient({
  apiKey: process.env.TYPESAFE_API_KEY ?? 'placeholder-overridden-by-proxy',
});

/** 標籤與其定義；Choice 的 criteria 和每個 Noul 都由這裡產生，確保兩邊措辭一致。 */
const LABELS = {
  billing: '帳務問題：扣款、退款、發票、訂閱金額',
  technical: '技術問題：功能異常、無法登入、效能',
  churn_risk: '客戶明確表達要取消訂閱或離開',
} as const;

type Label = keyof typeof LABELS;
const LABEL_KEYS = Object.keys(LABELS) as Label[];

const TICKETS = [
  { id: '雙議題', text: '我這個月被扣了兩次款，請盡快幫我處理，不然我要取消訂閱。' },
  { id: '純技術', text: '從昨天更新後我就一直無法登入，一直跳錯誤代碼 500。' },
  { id: '模糊', text: '我對這個服務不太滿意，想知道我還有什麼選擇？' },
] as const;

for (const ticket of TICKETS) {
  // Choice 與三個 Noul 互相獨立、共用同一份 state，所以一次送出。
  const { answers } = await client.systemOne({
    state: { ticket: ticket.text },
    questions: {
      // 相對：在三個類別之間擇一
      pick: choice('這張客服工單主要屬於哪一類？', { ...LABELS, other: '以上皆不適用' }),
      // 絕對：各自獨立判斷該面向是否成立，彼此可同時為真
      billing: noul(`這張工單是否涉及${LABELS.billing}？`),
      technical: noul(`這張工單是否涉及${LABELS.technical}？`),
      churn_risk: noul(`這張工單裡，${LABELS.churn_risk}，是否成立？`),
    },
  });

  const nouls = LABEL_KEYS.map((k) => answers[k].noul);
  const noulSum = nouls.reduce((a, b) => a + b, 0);

  console.log(`\n【${ticket.id}】${ticket.text}`);
  console.log(`  Choice → ${answers.pick.choice} (confidence ${answers.pick.confidence.toFixed(3)})`);
  console.log('  標籤          Choice機率   Noul');
  for (const [i, k] of LABEL_KEYS.entries()) {
    const p = answers.pick.probabilities[k];
    console.log(`    ${k.padEnd(12)} ${p.toFixed(3).padStart(8)} ${nouls[i]!.toFixed(3).padStart(8)}`);
  }
  console.log(`    ${'other'.padEnd(12)} ${answers.pick.probabilities.other.toFixed(3).padStart(8)} ${'—'.padStart(8)}`);
  console.log(`  總和：Choice 1.000（含 other，必為 1）｜三個 Noul ${noulSum.toFixed(3)}（不必為 1）`);
}
