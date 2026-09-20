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

環境變數（放 `.env`，已被 `.gitignore` 擋住，**絕對不要 commit**）：

| 變數 | 說明 |
| --- | --- |
| `TYPESAFE_API_KEY` | 必填 |
| `TYPESAFE_BASE_URL` | 預設 `https://api.typesafe.ai` |
| `TYPESAFE_DEFAULT_MODEL` | 預設 `jev-latest` |
| `TYPESAFE_LOG_LEVEL` | 預設 `warn`；除錯時設 `debug`（會印出完整 request body） |

### 在 Claude Code cloud session 裡跑（兩個必踩的坑）

**1. 一定要設 `NODE_USE_ENV_PROXY=1`。**
Node 的 `fetch` 預設不理 `HTTPS_PROXY`，不設的話 SDK 會失敗，而且錯誤訊息會誤導：

```
403 Host not in allowlist: api.typesafe.ai
```

這時候**不要**跑去改網路白名單 —— 同一台機器上 `curl` 是通的（curl 會讀那個環境變數），
問題只在 Node。`npm run smoke` 已經內建這個變數。

**2. API key 由 proxy 注入時，SDK 仍然需要一個佔位值。**
cloud environment 的 API credential 是在請求離開 VM 之後才由 proxy 加上 Authorization header，
key 不會進到容器裡。但 `new TypeSafeClient()` 沒拿到 key 會直接 throw，所以還是要給它一個字串：

```ts
new TypeSafeClient({ apiKey: process.env.TYPESAFE_API_KEY ?? 'placeholder' });
```

值是什麼不重要 —— 實測帶一把明顯錯誤的 key 仍然回 200，證明 proxy 是**覆蓋**而非略過。

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

## jev-1.13 的已知弱點

官方有一份 jagged edges 清單，**設計 question 前先讀**：
https://docs.typesafe.ai/model-jaggedness/jev-1.13.md

九個失敗模式摘要（都是「別讓模型做這件事」）：

| # | 失敗模式 | 改成 |
| - | --- | --- |
| 1 | 字面解讀：只回答你寫的字，不猜你的意思 | 把確切條件寫進 instructions，邊界情況寫進 criteria |
| 2 | 數學與計數不可靠 | 算術留在 code；要計數就逐項各問一次再自己加總 |
| 3 | 日期時間比較不可靠 | 用 Choice 抽出年/月/日各部分，比較與運算在 code |
| 4 | 多層間接、雙重否定 | 減少跳躍，直接指名 state 的欄位 |
| 5 | state 塞太多無關內容會掉準度 | 先在 code 過濾，只送問題需要的欄位 |
| 6 | 不會把 state 當敵意輸入 | criteria 寫明確，上線前測過邊界 |
| 7 | instructions 與 criteria 互相矛盾 | 兩者對齊；別讓 `true` 對應到「否」 |
| 8 | 結構不變式不保證 | 見下 |
| 9 | 不會生成文字 | 用生成模型；有界答案就改成 Choice |

### 第 8 項：Choice 與 Noul 不能互換門檻

- **Choice 是相對的**：在選項間分配機率，總和必為 1，回答「是哪一個」
- **Noul 是絕對的**：各自獨立，總和不必為 1，可以全高或全低

`src/choice-vs-noul.ts` 重現了這件事。工單「我對這個服務不太滿意，想知道我還有什麼選擇？」：

| 標籤 | Choice 機率 | Noul |
| --- | --- | --- |
| churn_risk | **0.650** | **0.100** |

同一個標籤，Choice 說 0.65、Noul 說 0.10。Choice 只是在說「硬要選的話選它」，
Noul 說的是「這件事其實不成立」。**在一邊調出來的門檻搬去另一邊會做出相反的決定。**

同理也別期待一個問題和它的否定，兩個 Noul 加起來等於 1（官方實測是 1.19）。

## 常用指令

```sh
npm install
npm run smoke          # 連線煙霧測試，會實際呼叫 Jev
npm run typecheck      # tsc --noEmit
```

單獨跑某支檔案（記得帶 proxy 變數）：

```sh
NODE_USE_ENV_PROXY=1 node src/xxx.ts
```

## 怎麼寫這個 repo 的文件

同一個主題**寫兩份、同檔名**，放在兩個目錄：

| 路徑 | 給誰 | 目的 |
| --- | --- | --- |
| `docs/<主題>.md` | 人類 | 快速理解結論與怎麼選 |
| `docs/agents/<主題>.md` | agent | 帶著完整證據動手做事 |

現有：`primitives.md`（Choice / Noul / Score）

**動手設計 question 前先讀 agent 版。**

### 人類版的規則

- **500 字以內。** 超過就是放了不該放的細節。
- 只寫**結論與判斷依據**，不寫推導過程。
- 可以引用**少數關鍵數字**當證據（例如「Choice 0.65 vs Noul 0.10」），
  但不放完整表格、不放 token 數、不放逐筆結果。
- **不放程式碼。** 要看程式碼的人會去看 `src/`。
- 結尾連到 agent 版。

### agent 版的規則

- **長度不限，但每一段都要有用。** 這份是要被照著做事的，不是給人讀爽的。
- **完整保留實測數據**：完整表格、token 數、耗時、失敗案例的前後對照。
- **每個數字都要能追溯**：標明是本 repo 實測（附模型版本與日期）還是抄自官方文件（附連結）。
  兩者不能混在同一句話裡。
- 反模式要寫**失敗案例的實際數據**，並說明**為什麼會失敗**（通常對應某個 jaggedness 失敗模式）。
  只寫「不要這樣做」沒有用，要讓讀的人能自己判斷新情況適不適用。
- 附 **API 簽章與回傳欄位**，以及踩過的坑（型別、參數位置這類）。
- 附**檢查清單**，讓人照順序走。
- 附**本 repo 相關實驗的檔案索引**與執行方式。
- **必須有「尚未驗證」一節。** 明確寫出還沒測過的東西、以及哪些數值是手挑的示範值。
  這節是為了防止後來的 agent 把示範值當成調校過的結論。

### 兩份共用的規則

- **結論變了要兩份一起改。** 只改一份會讓兩份互相矛盾，比沒有文件更糟。
- 人類版**不能有 agent 版沒有的資訊**（人類版是 agent 版的子集）。
- 新增主題時，在上面的表格補一行。
- 實驗腳本放 `src/`，文件只引用檔名，不把程式碼複製進文件。

## 官方文件

TypeSafe 的線上文件是唯一事實來源，寫整合前先讀：

- 索引：https://docs.typesafe.ai/llms.txt
- 頁面網址後面加 `.md` 可以拿到 Markdown，例如 https://docs.typesafe.ai/primitives/choice.md
- 常用：`concepts/system-one.md`、`state.md`、`primitives.md`、`confidence.md`、`sdk/javascript.md`

> `docs.typesafe.ai` 需要在 cloud environment 的網路白名單裡才連得到。
> 真的讀不到時，改看 `node_modules/@typesafe-ai/sdk/dist/index.d.mts` 的型別定義，
> 並且明講「沒讀到線上文件」，不要自行編造與版本相關的細節。

## Skill 來源

`.claude/skills/typesafe-ai/` 是從上游 vendored 進來的，不是自己寫的：

- 來源：https://github.com/typesafe-ai/skills（`skills/typesafe-ai/`）
- 版本：plugin `typesafe@typesafe-ai` v0.5.7，內容與上游逐字相同
- 一併保留上游的 MIT `LICENSE`

之所以直接放檔案而不是用 plugin marketplace，是因為實測確認過：
在 `.claude/settings.json` 宣告 `extraKnownMarketplaces` / `enabledPlugins`
**不會**讓全新的 cloud session 自動完成安裝。

要更新時直接覆蓋 `SKILL.md`（別順手改內容，才能保持可比對）：

```sh
curl -sS -o .claude/skills/typesafe-ai/SKILL.md \
  https://raw.githubusercontent.com/typesafe-ai/skills/main/skills/typesafe-ai/SKILL.md
```
