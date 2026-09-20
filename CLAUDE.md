# CLAUDE.md

## 這個 repo 是什麼

`jev-playground` 是用來**測試 Jev（TypeSafe 的 System One 模型）**的實驗場。
目的是快速試各種 question 寫法、觀察機率與 confidence 的行為，不是要做成正式產品。
所以這裡的程式碼以「小、可獨立執行、看得到輸出」為優先，不需要過度抽象。

## 執行環境

- **Node.js 22.18 以上**，直接執行 TypeScript：`node src/foo.ts`
  - type stripping 從 22.18 起預設開啟，不需要任何 flag（22.6～22.17 要加 `--experimental-strip-types`）
- 使用 Node 內建的 **type stripping**（型別剝離），**不編譯、不裝 ts-node / tsx / esbuild**
- ESM only：`package.json` 要有 `"type": "module"`
- TypeScript 只拿來做**型別檢查**（`tsc --noEmit`），不產出 JS

### 寫 code 時必須遵守的限制

Node 的 type stripping 只會把型別語法「抹掉」，不會做任何轉換，因此：

- ❌ 不能用 `enum`、`namespace`、constructor 的 parameter properties（`constructor(private x: T)`）、實驗性 decorators
  - 需要列舉時用 `const X = { a: 'a' } as const` 搭配 `type X = typeof X[keyof typeof X]`
- ✅ `import` 型別時一定要寫 `import type { Foo } from './foo.ts'`（或 `import { type Foo }`）
- ✅ 相對 import **要帶副檔名**，而且是 `.ts`：`import { run } from './run.ts'`
- `tsconfig.json` 請開 `erasableSyntaxOnly`、`verbatimModuleSyntax`、`allowImportingTsExtensions`、`noEmit`，
  `module` / `moduleResolution` 用 `nodenext`，這樣型別檢查會直接擋掉不能剝離的語法

> 這些限制在 Node 22 / 24 / 26 的行為一致，所以在 Node 22 上驗證過的 code 往上跑也沒問題。
>
> **不要拿 `bun` 來驗證。** Bun 有完整 transpile，`enum` 跑得動、import 省略副檔名也可以，
> 在 Bun 下過的 code 丟到 `node` 可能直接失敗。要跑就用 `node`。

## TypeSafe SDK

```sh
npm install @typesafe-ai/sdk
```

環境變數（放 `.env`，**絕對不要 commit**）：

| 變數 | 說明 |
| --- | --- |
| `TYPESAFE_API_KEY` | 必填 |
| `TYPESAFE_BASE_URL` | 預設 `https://api.typesafe.ai` |
| `TYPESAFE_DEFAULT_MODEL` | 預設 `jev-latest` |
| `TYPESAFE_LOG_LEVEL` | 預設 `warn`；除錯時設 `debug`（會印出 body） |

最小範例：

```ts
import { TypeSafeClient, choice, noul, score } from '@typesafe-ai/sdk';

const client = new TypeSafeClient();

const { answers, usage } = await client.systemOne({
  state: { ticket: '我被重複扣款兩次，請盡快處理' },
  questions: {
    // 從一組選項挑一個
    category: choice('這張工單屬於哪一類？', {
      billing: '帳務、扣款、退款相關',
      technical: '功能壞掉或操作問題',
      other: null,
    }),
    // 是/否，回傳「是」的機率
    urgent: noul('客戶是否要求立即處理？'),
    // 有序量尺，criteria 至少兩個、由低到高
    severity: score('對客戶造成的影響程度', [
      '沒有實際損失',
      '造成不便但可等待',
      '已經有金錢損失，需要立刻介入',
    ]),
  },
});

answers.category.choice;        // 'billing' | 'technical' | 'other'
answers.category.confidence;    // number
answers.category.probabilities; // 每個 label 的機率
answers.urgent.noul;            // 0..1，「是」的機率
answers.severity.score;         // 期望值，可能落在整數之間
usage;                          // input_tokens / output_tokens
```

回傳型別會從 `questions` 自動推導，**不要自己手寫 answer 的型別或 cast**。

## 設計 question 的原則

- **一個 question 只問一個判斷。** 可以拆成互相獨立的面向就拆開，但不要拆到破壞被判斷的關係本身。
- **把規則、計算、精確查表、實際執行留在程式碼裡**，只有「需要語意理解」的地方才交給 Jev。
- **state 要給足夠的背景**：原文、身分、關係、政策、當下事實。內容有多個部分時用具名 JSON 欄位，
  在 instructions 裡用反引號路徑指涉，例如 `` `ticket.messages[0].text` ``。
- question 的 key 只給程式用、**不會送給模型**，所以完整語意要寫在 instructions / criteria 裡。
- 可能「都不符合」時，criteria 要放一個 no-match 選項。
- **互相獨立、針對同一份 state 的問題一次送出**，它們會平行處理且看不到彼此的答案；
  只有當「需要前一個答案才能去撈資料或組出新的 state」時才發第二個 request。
- 機率與 confidence 的解讀：
  - `noul` 接近 0.5 是「是與否機率相近」，**不是**「中等程度」
  - `choice` / `score` 的 `confidence` 只代表機率分布的集中度，**不代表整體正確或可以直接執行**
  - 門檻值要拿自己的資料與實際後果來訂，別照抄 cookbook 的數字

## 常用指令

```sh
node src/xxx.ts        # 直接跑（Node 22.18+）
npx tsc --noEmit       # 型別檢查
```

## 文件

TypeSafe 的線上文件是唯一事實來源，寫整合前先讀：

- 索引：https://docs.typesafe.ai/llms.txt
- 頁面網址後面加 `.md` 可以拿到 Markdown，例如 https://docs.typesafe.ai/primitives/choice.md
- 常用：`concepts/system-one.md`、`state.md`、`primitives.md`、`confidence.md`、`sdk/javascript.md`

> 目前這個遠端容器的 egress proxy **擋住 `docs.typesafe.ai`**。
> 讀不到文件時，改看 `node_modules/@typesafe-ai/sdk/dist/index.d.mts` 的型別定義，
> 並且明講「沒讀到線上文件」，不要自行編造與版本相關的細節。
