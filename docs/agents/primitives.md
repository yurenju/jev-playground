# Jev primitives — 完整脈絡（給 agent 讀）

給要在這個 repo 裡設計 question 的 agent。人類版摘要在 [`docs/primitives.md`](../primitives.md)。
本文保留所有實測數據與推導過程，**數字都是這個 repo 實際跑出來的**，不是從文件抄的。

模型：`jev-1.13.0`（透過 `jev-latest` 取得，2026-09 實測）。

---

## 0. 心智模型

Jev 是 System One 模型：**回傳帶機率的分類判斷，不生成文字、不做推理說明**。
程式擁有流程，模型只在「需要語意理解」的地方提供判斷。

推論：**規則、算術、精確查表、排序、執行，全部留在 code**。
把這些交給模型不只是浪費，而是已知會錯（見 §5 的失敗模式 2、3）。

---

## 1. 三個 primitive 的 API 與回傳

來自 `@typesafe-ai/sdk` v0.6.0（`node_modules/@typesafe-ai/sdk/dist/index.d.mts`）。

```ts
choice(instructions: EntryType, criteria: { [label: string]: Description }): ChoiceQuestion
noul  (instructions?: EntryType, criteria?: { true?: EntryType; false?: EntryType } | null): NoulQuestion
score (instructions: EntryType, criteria: readonly [EntryType, EntryType, ...EntryType[]]): ScoreQuestion
```

`EntryType = string | JSON 物件 | JSON 陣列 | null`。
需要定義、對比、排除、範例時用結構化物件，簡單問題用字串就好。

回傳（型別會從 `questions` 自動推導，**不要手寫型別或 cast**）：

| Primitive | 回傳欄位 |
| --- | --- |
| Choice | `choice`（選中的 label，型別是字面聯集）、`confidence`、`probabilities`（每 label） |
| Noul | `noul`（0～1）。**沒有 confidence** —— 機率本身就是答案 |
| Score | `score`（期望值，可落在整數之間）、`confidence`、`probabilities`（每等級）、`legend` |

`systemOne()` 另外回傳 `model` 與 `usage: { input_tokens, output_tokens }`。

⚠️ `noul()` 的 criteria 是**第二個參數**，鍵是 `true` / `false`。
別把 criteria 塞進 instructions 物件裡（這個錯誤本 repo 犯過，型別檢查不會擋）。

---

## 2. 相對 vs 絕對 —— 最重要的一條

- **Choice 是相對的**：機率在選項間分配，總和必為 1。回答「是哪一個」。
- **Noul 是絕對的**：各題獨立，總和不必為 1。回答「這件事成不成立」。

`src/choice-vs-noul.ts` 對同一組標籤同時用兩種問法，實測：

**工單 A「我這個月被扣了兩次款，請盡快幫我處理，不然我要取消訂閱。」**

| 標籤 | Choice | Noul |
| --- | --- | --- |
| billing | 0.740 | 0.980 |
| technical | 0.000 | 0.170 |
| churn_risk | 0.260 | 0.320 |
| other | 0.000 | — |
| **總和** | **1.000** | **1.470** |

**工單 B「從昨天更新後我就一直無法登入，一直跳錯誤代碼 500。」**

| 標籤 | Choice | Noul |
| --- | --- | --- |
| technical | 1.000 | 0.980 |
| 其餘 | 0.000 | ≤0.03 |
| **總和** | **1.000** | **1.030** |

**工單 C「我對這個服務不太滿意，想知道我還有什麼選擇？」← 關鍵案例**

| 標籤 | Choice | Noul |
| --- | --- | --- |
| billing | 0.000 | 0.130 |
| technical | 0.000 | 0.130 |
| **churn_risk** | **0.650** | **0.100** |
| other | 0.350 | — |
| **總和** | **1.000** | **0.360** |

C 的 `churn_risk` 在 Choice 得 0.650、在 Noul 只有 0.100。
三個標籤其實都不成立（Noul 全低、總和 0.36），但 Choice 必須分配完 1.0，
所以把機率堆給了「相對最像」的那個。

**因此：在一個 primitive 上調出來的門檻，搬到另一個會做出相反的決定。**

官方另外記載：一個問題和它的否定，兩個 Noul 加起來可能是 1.19 而非 1。
**不要假設任何算術恆等式。**

推薦組合（官方 skill suggestion cookbook 的做法）：
**Noul 決定「要不要處理」（絕對），Choice 決定「歸到哪一類」（相對）。**
C 的情形下，三個 Noul 都低就該直接判定「不屬於任何一類」，不該採用 Choice 的結果。

---

## 3. Score 的性質

`src/task-breakdown.ts` 對九個任務問「完成需要的工作規模」，四個等級由低到高：

```
0 一個動作就能做完，通常幾分鐘內結束，例如傳一則訊息、買一樣東西、按一個按鈕。
1 需要連續做幾件小事，但一次坐下來就能全部完成，不需要事先安排時間或等待別人。
2 必須分成多次進行，或中途要等待他人回覆、等外部流程，無法一次做完。
3 要先花時間規劃才知道有哪些步驟，牽涉多個階段或多方協調。
```

| 任務 | score | confidence |
| --- | --- | --- |
| 買牛奶 | 0.03 | 0.97 |
| 修正登入頁面的錯字 | 0.40 | 0.60 |
| 繳這個月的水電費 | 0.71 | 0.61 |
| 回覆客戶的報價信 | 0.76 | 0.61 |
| 研究要不要換一個記帳 app | 1.48 | 0.52 |
| 跟房東談續約 | 1.71 | 0.64 |
| 規劃明年春天的日本旅行 | 2.97 | 0.97 |
| 準備下週的產品發表會 | 2.99 | 0.99 |
| 重寫整個報表系統 | 3.00 | 1.00 |

單調、分得開、符合直覺。以 `score >= 1.5` 為門檻，九筆全部合理。

觀察：**confidence 在量尺中段偏低（0.52～0.64），兩端接近 1.0**。
這不是模型出錯 —— 中段本來就介於兩個等級之間。
「研究要不要換記帳 app」1.48 卡在門檻邊、confidence 0.52 最低，屬於真實的模糊，
適合回問使用者而不是自動決定。

規則：
- 每個等級要**描述具體情境且能獨立成立**，不能寫「小／中／大」這種形容詞。
- **不要用期望值反推實際數量。** 官方明說 Score 在數值上校準很弱，
  不能靠內插還原「介於兩級之間的真實數字」。只能拿來比門檻。

---

## 4. 反模式：自己加一個 Noul 當信心閘門

本 repo 在兩個獨立案例上犯了同一個錯，都失敗。

**案例一 `src/expense-category.ts`** —— Choice 分八類，外加一個
「描述是否不足以判斷用途、需要人工確認」的 Noul。

| 商家 | 分類 | Choice conf | 閘門 Noul |
| --- | --- | --- | --- |
| 全聯福利中心 | groceries | 1.00 | 0.84 |
| 星巴克 | dining | 1.00 | 0.73 |
| Anthropic（Claude Pro） | subscription | 1.00 | 0.26 |
| 誠品書店 | education | 0.99 | 0.74 |
| **屈臣氏** | health | **0.68** | 0.90 |
| Uber | transport | 1.00 | 0.87 |
| momo（電風扇） | household | 1.00 | 0.16 |
| **7-11** | groceries | **0.60** | 0.93 |

分類 8 筆全對。但**閘門 Noul 把 8 筆送審 6 筆**，實務上等於關掉自動化。

原因是字面解讀（失敗模式 1）：我問「資訊是否不足以判斷用途」，
而嚴格來說大多數商家都可能跨類別（Uber 可能是 Uber Eats、全聯可能買日用品），
所以高分是**對的**，只是這個判斷對決策沒有鑑別力。

`Choice.confidence` 反而精準：只有屈臣氏（0.68，藥品 vs 日用品）和
7-11（0.60，什麼都賣）掉下來，正好就是該人工確認的兩筆。

**案例二 `src/task-breakdown.ts`** —— Score 外加一個「能否直接動手」的 Noul。

| 任務 | score | 閘門 Noul | 只看 Score | Score + Noul |
| --- | --- | --- | --- | --- |
| 修正登入頁面的錯字 | 0.40 | 0.26 | 直接記錄 ✅ | **展開 ❌** |
| 回覆客戶的報價信 | 0.76 | 0.29 | 直接記錄 ✅ | **展開 ❌** |
| 其餘七筆 | — | — | 合理 | 相同 |

Noul 判「修正登入頁面的錯字」為 0.26（不能直接動手），因為沒指明是哪個錯字 ——
字面上成立，但這不是「需要展開成子任務」的理由。**加上閘門反而弄壞兩筆。**

**結論：要衡量主判斷的不確定性，看主判斷自己的 `confidence` / `probabilities`。**
額外的 Noul 只會回答它字面問的那件事，不會回答「你該不該相信前一題」。

⚠️ 但這不推翻「confidence 不等於正確性」。confidence 衡量的是**機率分布集中度**。
記帳案例之所以有效，是因為「這個商家是否跨類別」本身就等同於「分布散不散」。
當你要判斷的是「答案對不對」而非「選項之間是否難分」時，confidence 無法代勞。

---

## 5. jev-1.13 的九個失敗模式

來源：https://docs.typesafe.ai/model-jaggedness/jev-1.13.md（設計 question 前先讀）

| # | 失敗模式 | 對策 |
| - | --- | --- |
| 1 | **字面解讀**：只回答你寫的字，不猜意圖 | 確切條件寫進 instructions，邊界寫進 criteria。發現自己在解釋「我其實是想問…」時，那段解釋就是缺的那一半 |
| 2 | **數學與計數不可靠** | 算術留在 code。要計數就逐項各問一個 Noul 再自己加總 |
| 3 | **日期時間比較不可靠** | 用 Choice 抽出年/月/日各部分（都是小的封閉集合，並留「未提及」選項），比較與運算在 code |
| 4 | **多層間接、雙重否定** | 減少跳躍，直接指名 state 欄位 |
| 5 | **context rot**：state 塞無關內容會掉準度 | 先在 code 過濾，只送問題需要的欄位 |
| 6 | **不把 state 當敵意輸入** | criteria 寫明確，上線前測邊界 |
| 7 | **instructions 與 criteria 矛盾** | 兩者對齊；別讓 `true` 對應到「否」 |
| 8 | **結構不變式不保證** | 見 §2 |
| 9 | **不會生成文字** | 用生成模型；答案有界就改成 Choice over options |

---

## 6. 設計 question 的檢查清單

1. 這題該用哪個 primitive？（§1 的語意，不是輸出形狀）
2. 有沒有把算術／查表／排序誤丟給模型？→ 移回 code
3. state 有沒有塞不需要的欄位？→ 刪掉（失敗模式 5）
4. instructions 寫的是**確切條件**還是我心裡想的意思？（失敗模式 1）
5. criteria 有沒有涵蓋邊界？Choice 有沒有 no-match 選項？
6. Score 的每一級是不是**具體情境**而非形容詞？
7. 互相獨立、共用同一份 state 的題目，**有沒有放在同一個 request**？
   （它們平行處理且看不到彼此的答案；只有「需要前一題答案才能組出新 state」時才發第二個 request）
8. question 的 key **不會送給模型**，完整語意有沒有寫進 instructions / criteria？
9. 門檻是拿自己的資料訂的，還是照抄 cookbook？

---

## 7. 本 repo 的實驗

| 檔案 | 驗證什麼 |
| --- | --- |
| `src/smoke.ts` | 連線與三個 primitive 的基本煙霧測試 |
| `src/choice-vs-noul.ts` | §2 相對 vs 絕對 |
| `src/expense-category.ts` | §4 案例一（Choice + 閘門 Noul vs confidence） |
| `src/task-breakdown.ts` | §3 Score 校準、§4 案例二 |

執行：`NODE_USE_ENV_PROXY=1 node src/<檔名>.ts`（環境細節見 `CLAUDE.md`）。

成本參考：smoke 的三題單一 request 用掉 `input 607 / output 78` tokens。
額外的題目仍然計費，要量測實際的 request 數、成本與端到端延遲。

---

## 8. 尚未驗證

以下**還沒測過**，不要當成已知結論：

- 失敗模式 3（日期比較）與 5（context rot）在本 repo 尚無對照實驗
- `jev-preview` 與 `jev-latest` 的差異
- 多輪（需要前一題答案才能組出 state）的情形
- 所有門檻值（1.5、0.5、0.8）都是**手挑的示範值**，沒有用標註資料調過

---

## 來源

- 官方文件索引：https://docs.typesafe.ai/llms.txt（頁面路徑後加 `.md` 取得 Markdown）
- jaggedness：https://docs.typesafe.ai/model-jaggedness/jev-1.13.md
- primitives：`primitives.md`、`primitives/{choice,noul,score,advanced}.md`
- confidence：https://docs.typesafe.ai/confidence.md
- 本 repo 的 skill：`.claude/skills/typesafe-ai/SKILL.md`
