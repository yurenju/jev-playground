# 批次處理 — 完整脈絡（給 agent 讀）

多筆資料、每筆一個判斷時，該逐筆送還是塞進同一個 request。
人類版摘要在 [`docs/batching.md`](../batching.md)。

**本文的實測數據**：模型 `jev-1.13.0`，2026-09-20 跑於本 repo。
**引用官方文件處會標明連結**，兩者不混寫。

---

## 0. 結論

**每個 request 約 20 筆，在 code 裡切塊。** 與逐筆結果一致，快十幾倍，省約 35%。

---

## 1. 兩種形狀，不要混淆

官方 [parallel_questions cookbook](https://docs.typesafe.ai/cookbooks/parallel_questions.md)
的結論是批次不影響答案：

> each question is scored on its own against the document, so its answer doesn't
> depend on what else is in the request

該案例是 GDPR 維基條目（約 54,000 字元）配 13 個問題，批次便宜 12.2 倍、快 10.0 倍，
答案不變。

**但那是「一份大文件 + N 個問題」的形狀**：文件是每個 request 的主體，
逐題送要付 N 次文件的錢，批次只付一次。每一題都**應該**看得到整份文件。

**「N 筆資料 + 每筆一題」是不同的形狀。** 批次時 `transactions[3]` 那一題
也看得到另外 N-1 筆，而那些對它來說是無關內容 ——
即 [jaggedness #5 context rot](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md)：

> Accuracy falls as the state grows with content unrelated to the decision.

**所以官方那句「批次不影響答案」不能套用到這個形狀。** 下面是實測。

---

## 2. 規模與一致率（`src/batch-scaling.ts`）

基準 = 逐筆送（每個 request 的 state 只含該筆，`transactions[0]`）。
批次 = 一個 request 含全部，每題引用 `transactions[i]`。
兩邊的問題措辭與 criteria 完全相同，只差 state 內容。

| 批次筆數 | input tokens | 耗時 | 與逐筆一致 | 平均 confidence | 最常見標籤佔比 |
| --- | --- | --- | --- | --- | --- |
| 12 | 5,043 | 246 ms | **12/12 (100%)** | 0.87 | groceries 25% |
| 18 | 7,430 | 271 ms | **18/18 (100%)** | 0.86 | groceries 17% |
| 24 | 9,820 | 311 ms | **24/24 (100%)** | 0.81 | groceries 17% |
| 30 | 12,217 | 300 ms | 29/30 (97%) | 0.79 | groceries 17% |
| 36 | 14,609 | 282 ms | 30/36 (83%) | 0.68 | groceries 25% |
| 48 | 19,387 | 434 ms | 31/48 (65%) | 0.57 | **entertainment 25%** |
| 72 †| 28,957 | 504 ms | 32/72 (44%) | — | 大量塌陷到 entertainment |

† 72 那列來自稍早一次獨立執行（腳本設定相同，當時尚未輸出 confidence）。

**拐點在 24～30 之間。** 24 筆仍 100%，30 筆掉第一筆。

**可重現性**：12 筆與 36 筆各跑過兩次，一致數完全相同（12/12、30/36）。
這不是隨機雜訊，是隨規模單調劣化。

### 塌陷現象

72 筆時多數答案擠到 `entertainment`，包括全聯、星巴克、誠品、屈臣氏、中油等
彼此毫不相關的商家。48 筆時 `entertainment` 已佔 25%。

這**不像單純的準確度下降，比較像模型無法再把 `transactions[i]` 對應回正確那筆**。
此推測尚未驗證，見 §6。

---

## 3. confidence 可作為劣化訊號

平均 confidence 與一致率同步下降：

```
24 筆  conf 0.81   一致 100%
30 筆  conf 0.79   一致  97%
36 筆  conf 0.68   一致  83%
48 筆  conf 0.57   一致  65%
```

**實務用法**：線上沒有標準答案，但可以監控每批的平均 confidence。
若低於在小批次量到的基線（此資料集為 0.81～0.87），就把批次切小重跑。

⚠️ 這條與 `docs/agents/primitives.md` §4 的「confidence 不等於正確性」不衝突：
confidence 衡量機率分布集中度，而 context rot 正是透過讓分布變散來損害答案。
**這不代表 confidence 在其他失敗模式下也能當警報。**
只有一組資料集，見 §6。

---

## 4. 三種策略的成本（`src/batch-vs-single.ts`，12 筆）

| 策略 | input tokens | 耗時 | 與逐筆一致 | 每 1000 筆成本 |
| --- | --- | --- | --- | --- |
| **A** 逐筆，12 requests | 7,810 | 3,493 ms | 基準 | $0.0273 |
| **B** 批次，1 request | 5,040 | **231 ms** | **12/12** | $0.0176 |
| **C** 批次＋規則移到 state | 2,302 | 205 ms | 10/12 | $0.0081 |

價格依 [models.md](https://docs.typesafe.ai/models.md)：$0.042 / Mtok input，output 免費。

推算 1000 筆：逐筆約 **291 秒**（≈5 分鐘）；切 20 筆一批共 50 個 request，約 **15 秒**。

**速度是批次的主要價值，成本差距只有約 35%。**

### 策略 C 為什麼不要用

C 把分類規則放進 `state.rules`，Choice 的 criteria 每個標籤給 `null`（不附描述），
instructions 改寫成「依照 `rules` 的定義…」。token 少一半以上，但 12 筆錯 2 筆：

| 商家 | 逐筆（基準） | 策略 C |
| --- | --- | --- |
| 屈臣氏 | health | household |
| 統一超商 | groceries | dining |

**criteria 的描述留在每一題裡才可靠。** 省下的錢（每千筆 $0.009）不值得換準確度。

推測原因：criteria 是模型評分時直接對照的定義，放進 state 變成「要先找到再套用」的
間接參照，對應 [jaggedness #4 indirection](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md)。
**此推測尚未驗證。**

---

## 5. 實作

```ts
const CHUNK = 20;

for (let i = 0; i < transactions.length; i += CHUNK) {
  const chunk = transactions.slice(i, i + CHUNK);
  const questions = Object.fromEntries(
    chunk.map((_, j) => [
      `tx${j}`,
      choice(`\`transactions[${j}]\` 這筆消費應該記到哪一個帳目類別？`, RULES),
    ]),
  );
  const { answers } = await client.systemOne({
    state: { transactions: chunk },   // 只放這一批，不要放全部
    questions,
  });
  // 用 j 對回 chunk[j]，並記錄 answers[`tx${j}`].confidence 供監控
}
```

重點：
- `state` 只放**當批**，不是全部資料。
- 題目 key（`tx0`…）只給程式用，**不會送給模型**，語意要寫在 instructions 裡。
- criteria（`RULES`）在每一題都完整帶上，不要為了省 token 拿掉。
- 留著每題的 `confidence` 做 §3 的監控。

### 官方硬限制（[models.md](https://docs.typesafe.ai/models.md)）

| 項目 | 限制 |
| --- | --- |
| 每 request 總計 | 64k tokens（state + 所有問題） |
| state + 最長的單一問題 | 32k tokens |
| 速率 | 250,000 tokens/秒；1,200 requests/分 |

**注意：24 筆這個拐點遠早於 64k 上限**（24 筆只用 9,820 tokens，約 15%）。
**準確度的上限比 context 上限嚴格得多，不要用 token 額度來決定批次大小。**

官方另註明速率限制會無預警調整。

### 兩個型別上的坑

- `state` 不能傳 `as const` 產生的 readonly 陣列。
- 物件型別要用 `type` 而非 `interface`（interface 沒有隱含索引簽章，
  不符合 SDK 的 `JsonValue`）。

兩者 `tsc --noEmit` 都會擋，但錯誤訊息很長且不好讀。

---

## 6. 尚未驗證

**不要把以下當成已知結論。**

- **拐點由什麼決定？** 實驗只變動筆數，而題數、state 大小、token 總量是綁在一起變的，
  沒有拆開。若真正的變因是 token 量，那每筆欄位變多（幣別、卡號、備註）
  會讓拐點往前移。**`CHUNK = 20` 是在 24 與 30 之間手挑的保守值，不是調校過的。**
- **塌陷的成因**（§2）未驗證。若成因是索引對應失敗，
  改用商家名稱或交易 ID 當 state 的 key 可能大幅改善 —— 這是個沒測過的不同解法。
- **confidence 當警報是否可靠**（§3）只有這一組資料，可能是巧合。
  也未測過它對其他失敗模式是否有效。
- **策略 C 的失敗原因**（§4）是推測，未做對照實驗。
- 只測過 Choice。**Noul 與 Score 的批次行為未測。**
- 只測過中文商家名稱。官方註明
  [英文準確度最好](https://docs.typesafe.ai/models.md)，
  CJK「handled but not equally well」，未比較過語言對拐點的影響。
- 批次是否影響「逐筆」的絕對正確率未知：本文只量**一致率**，
  基準是逐筆的答案，而逐筆本身沒有人工標註驗證過。

---

## 7. 本 repo 的實驗

| 檔案 | 驗證什麼 |
| --- | --- |
| `src/batch-vs-single.ts` | §4 三種策略的成本與一致率 |
| `src/batch-scaling.ts` | §2 規模與一致率、§3 confidence 訊號 |

執行：`NODE_USE_ENV_PROXY=1 node src/<檔名>.ts`

---

## 來源

- 官方 cookbook：https://docs.typesafe.ai/cookbooks/parallel_questions.md
- 模型限制與價格：https://docs.typesafe.ai/models.md
- jaggedness：https://docs.typesafe.ai/model-jaggedness/jev-1.13.md
- 相關：[`docs/agents/primitives.md`](primitives.md)
