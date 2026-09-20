/**
 * 實驗 2：判斷一個任務該「展開成子任務」還是「直接記錄」。
 *
 *   NODE_USE_ENV_PROXY=1 node src/task-breakdown.ts
 *
 * 設計取捨：
 *   - 「規模」是有序的程度 → Score，四個等級各自描述具體情境（不是形容詞）
 *   - 「能不能直接開始做」是獨立成立的事 → Noul
 *     大任務不一定要拆（可能很明確），小任務也可能卡在不清楚要做什麼，
 *     所以這兩件事分開問，由 code 決定最後行為。
 *   - 決策規則寫在 code，不問模型「要不要展開」（那是政策，不是判斷）。
 */
import { TypeSafeClient, noul, score } from '@typesafe-ai/sdk';

const client = new TypeSafeClient({
  apiKey: process.env.TYPESAFE_API_KEY ?? 'placeholder-overridden-by-proxy',
});

const TASKS = [
  '買牛奶',
  '繳這個月的水電費',
  '修正登入頁面的錯字',
  '回覆客戶的報價信',
  '跟房東談續約',
  '研究要不要換一個記帳 app',
  '準備下週的產品發表會',
  '規劃明年春天的日本旅行',
  '重寫整個報表系統',
] as const;

/** 政策寫在 code：規模夠大、或還不能直接動手，就建議展開。 */
const SIZE_THRESHOLD = 1.5;
const READY_THRESHOLD = 0.5;

console.log('任務                          規模  conf  可直接動手   只看Score      Score+Noul');
console.log('─'.repeat(86));

for (const task of TASKS) {
  const { answers } = await client.systemOne({
    state: { task },
    questions: {
      size: score('完成 `task` 所描述的這件事，需要的工作規模', [
        '一個動作就能做完，通常幾分鐘內結束，例如傳一則訊息、買一樣東西、按一個按鈕。',
        '需要連續做幾件小事，但一次坐下來就能全部完成，不需要事先安排時間或等待別人。',
        '必須分成多次進行，或中途要等待他人回覆、等外部流程，無法一次做完。',
        '要先花時間規劃才知道有哪些步驟，牽涉多個階段或多方協調。',
      ]),
      ready: noul(
        '`task` 的內容是否已經具體到可以立刻開始動手，不需要先釐清要做什麼？',
        {
          true: '已經指明了要做的具體動作與對象。',
          false: '只說了一個目標或方向，還要先想清楚包含哪些事情才能開始。',
        },
      ),
    },
  });

  const { size, ready } = answers;
  // 對照兩種政策：只看規模，或再加上「能不能直接動手」這個 Noul
  const bySize = size.score >= SIZE_THRESHOLD;
  const byBoth = bySize || ready.noul < READY_THRESHOLD;
  const label = (expand: boolean) => (expand ? '展開' : '直接記錄');

  console.log(
    `${task.padEnd(26)}${size.score.toFixed(2).padStart(6)}  ${size.confidence.toFixed(2)}` +
      `${ready.noul.toFixed(2).padStart(10)}   ${label(bySize).padEnd(12)} ${label(byBoth)}`,
  );
}
