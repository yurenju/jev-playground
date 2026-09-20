/**
 * 連線與三個 primitive 的煙霧測試。
 *
 *   npm run smoke
 *
 * API key 的來源有兩種，都可以：
 *   1. cloud environment 的 API credential —— proxy 會在請求離開 VM 後覆寫
 *      Authorization header，所以 TYPESAFE_API_KEY 給任意佔位字串即可。
 *   2. 一般環境變數 TYPESAFE_API_KEY。
 */
import { TypeSafeClient, choice, noul, score } from '@typesafe-ai/sdk';

// SDK 的 constructor 沒有 key 會直接 throw，即使實際的 key 由 proxy 注入。
const client = new TypeSafeClient({
  apiKey: process.env.TYPESAFE_API_KEY ?? 'placeholder-overridden-by-proxy',
});

const ticket = {
  customer: '王小明',
  plan: 'Pro',
  messages: ['我這個月被扣了兩次款，請盡快幫我處理，不然我要取消訂閱。'],
};

const models = await client.models.list();
console.log('可用模型：', models.map((m) => m.name).join(', '));

// 三個判斷互相獨立、針對同一份 state，所以一次送出、平行處理。
const { model, answers, usage } = await client.systemOne({
  state: { ticket },
  questions: {
    category: choice('這張客服工單主要屬於哪一類？', {
      billing: '帳務問題：扣款、退款、發票、訂閱金額',
      technical: '技術問題：功能異常、無法登入、效能',
      churn_risk: '客戶明確表達要取消或離開',
      other: '以上皆不適用',
    }),
    urgent: noul({
      question: '客戶是否要求立即或盡快處理？',
      evidence: '依據 `ticket.messages` 的用字判斷，而非問題本身的嚴重程度。',
    }),
    severity: score('這件事對客戶造成的實際影響程度', [
      '沒有實際損失，只是詢問',
      '造成不便，但客戶可以等待',
      '已經產生金錢損失或服務中斷，需要立刻介入',
    ]),
  },
});

console.log('\n模型：', model);
console.log('分類：', answers.category.choice, `(confidence ${answers.category.confidence.toFixed(3)})`);
console.log('  機率分布：', answers.category.probabilities);
console.log('急迫：', answers.urgent.noul.toFixed(3), '← 這是「是」的機率，不是程度');
console.log('嚴重度：', answers.severity.score.toFixed(3), `(confidence ${answers.severity.confidence.toFixed(3)})`);
console.log('  機率分布：', answers.severity.probabilities);
console.log('\nusage：', usage);

// 門檻只是示範，實際值要拿自己的資料和後果來訂。
if (answers.category.choice === 'churn_risk' || answers.urgent.noul > 0.9) {
  console.log('\n→ 路由：真人客服優先處理');
} else {
  console.log('\n→ 路由：一般佇列');
}
