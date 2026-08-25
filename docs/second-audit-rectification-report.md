# Codex Obsidian Second Brain 第二次独立复审问题全面整改与闭环交付报告

- **报告日期**：2026-08-25
- **代码基线**：`9fe145dfe52bfa52d21850e70939b390b3150228`
- **整改状态**：全部 P1（3项）、R1（1项）、P2（7项）已关闭
- **测试结果**：129/129 项自动化测试通过，40/40 语义/词法评测通过，全量覆盖率及打包检查通过

---

## 一、 复审问题整改对照清单 (Traceability Matrix)

| 编号 | 严重级别 | 问题描述 | 关键修复文件与逻辑 | 闭环测试用例与验证方式 | 状态 |
|---|---|---|---|---|---|
| **P1-03** | **P1 (Blocker)** | 锁安全性与时钟回拨/未来时间戳判定缺陷 | `src/lock.js:39-80`<br>• `isSyncLockActive` 与 `isLockDeadOrStale` 将 PID 存活检查（`isPidAlive`）前置为主导判定。<br>• 存活 PID 若遭遇未来时间戳（`heartbeatAge < 0`），严格判定为 active，禁止判定为 stale 或被抢占。 | `test/lock-future-clock.test.js`<br>• 验证存活 PID + 60s 未来时间戳无法被抢占。<br>• 验证死亡 PID + 未来时间戳被安全回收。 | **CLOSED** |
| **P1-01** | **P1 (Blocker)** | 事实相关性与意图绑定缺失，跨实体背书风险 | `src/evidence.js:315-440`<br>• 解耦被问实体（`entityTerms`）与意图属性（`INTENT_PATTERNS`）。<br>• 要求单条证据**必须同时满足实体与意图**，跨实体同意图严禁背书。<br>• 严格执行弱权威判定：`authorityScore: 45` 单独存在时判定为 `insufficient`。 | `test/evidence-grounding.test.js`<br>• 构造“火星香蕉费用/权限/状态”反例，实测返回 `insufficient`。<br>• 验证弱权威会议纪要无法单独判定为 `grounded`。 | **CLOSED** |
| **P1-02** | **P1 (Blocker)** | 候选审计 Outbox 事务未清零与幂等缺失 | `src/candidates.js:90-130`<br>`src/audit.js:99-125`<br>`schemas/audit-event.schema.json`<br>• 引入必需的 `eventId: randomUUID()`。<br>• 审计 JSONL 按 `eventId` 进行幂等去重追加。<br>• `load()` 重放成功后强制**原子写回磁盘清零 `pendingAudits`**。<br>• `supersede` 保证新旧事件共享 `traceId` 但拥有独立 `eventId`。 | `test/candidates-outbox.test.js`<br>• 验证二次重放 0 重复条目、磁盘 pending 彻底清零。<br>• 验证 supersede 状态流转独立 `eventId`。 | **CLOSED** |
| **R1-01** | **R1 (Blocker)** | 发布扫描器十六进制边界误判手机号 | `scripts/scan-release.ps1:154, 321`<br>• 手机号与身份证号正则增加 `(?<![0-9a-fA-F])` 与 `(?![0-9a-fA-F])` 上下文限定。<br>• `SHA256SUMS` 采用专用校验机制，不再作为自然语言 PII 文本扫描。 | `test/probes-regression.test.js:255-293`<br>• 验证包含 `1[3-9]\d{9}` 样式的 SHA-256 校验和 100% 稳定通过，同时真实手机号被 100% 拦截。 | **CLOSED** |
| **P2-03** | **P2 (Quality)** | WAL Checkpoint 状态透传与降级诊断 | `src/fastembed_worker.py:27-35`<br>`src/qmd-adapter.js:297-315`<br>• 区分向量入库成功与 WAL checkpoint 锁争用（busy/error）。<br>• 在 `metadata.json` 与 `syncResult` 中完整透传 `checkpointStatus`。 | `test/probes-regression.test.js`<br>• 验证同步元数据与健康指标中准确记录 checkpoint 状态。 | **CLOSED** |
| **P2-04** | **P2 (Quality)** | CommonMark Fence 切块测试表驱动与 UTF-16 检查 | `test/chunker-fences.test.js`<br>• 建立 3/4/5 反引号、波浪线 `~~~`、嵌套代码块及未闭合 Fence 的表驱动测试集。<br>• 引入严格的正则逐字符 UTF-16 未配对 surrogate 检查。 | `test/chunker-fences.test.js`<br>• 5/5 项切块与编码用例实测通过。 | **CLOSED** |
| **P2-05** | **P2 (Quality)** | `records.json` 损坏自愈与全量 Schema 校验 | `src/candidates.js:20-88`<br>• `sanitizeRecord` 对所有关键字段做 Draft 2020-12 规范化；非标准 ID 确定性转换为合法 UUID。<br>• 发生任何字段自愈或去重时，无论记录总数是否变化，均强制原子写回磁盘。 | `test/candidates-recovery.test.js`<br>`test/candidates-outbox.test.js`<br>• 验证重复 ID、非标准字段自愈及无长度变化的写回落盘。 | **CLOSED** |
| **P2-06** | **P2 (Quality)** | Windows 目录删除重试与错误传播 | `src/lock.js:86-148`<br>• `safeRmDir` 遇到非瞬态锁错误立即返回 `false`。<br>• `cleanStaleReclaimLock` 统一调用 `safeRmDir` 避免单次 bare `rmSync` 崩溃。 | `test/lock-retry.test.js`<br>• 使用 Windows `[System.IO.FileShare]::None` 独占文件句柄模拟真实文件锁定，验证重试耗尽与解锁后成功。 | **CLOSED** |
| **P2-07** | **P2 (Quality)** | Python Worker 真实退出确认与 MCP 关机治理 | `src/semantic-adapter.js:15-58, 100-140`<br>`src/mcp-server.js:181-200`<br>• 关机时先关闭 transport / server 停止接收新请求，再调用 `killAllActiveWorkers`。<br>• 追踪 Worker 进程至真实的 `exit` / `close` 事件；Windows 平台使用 `taskkill /F /PID <pid> /T` 保证进程树完全退出。 | `test/lock-retry.test.js`<br>• 实测真实子进程生命周期终止与空集合兼容。 | **CLOSED** |
| **P2-08** | **P2 (Quality)** | 原子持久化安全写入与声明降级 | `src/io.js:5-35`<br>• `writeJsonAtomic` 使用 `writeFileSync(fd, payload, 'utf8')` 确保完整数据写入内核缓冲区，再调用 `fsyncSync` 与原子 `renameSync`。 | `test/powerloss-recovery.test.js`<br>• 验证断电模拟与损坏文件安全降级。 | **CLOSED** |
| **P2-09** | **P2 (Quality)** | `.npmignore` 缓存排除与全量回归 | `.npmignore`<br>• 显式排除 `**/__pycache__/**`、`**/*.pyc`、`**/*.pyo` 及临时测试目录。 | `npm run pack:check`<br>• `npm pack --dry-run` 产出干净的 97 个文件包清单。 | **CLOSED** |

---

## 二、 实机验证与闭环测试结果

在当前 Windows 实机运行环境中执行了完整的全量回归与各项工程检查：

```powershell
# 1. 静态规范检查
> npm run check
node scripts/check.mjs
Static checks passed. (Exit Code: 0)

# 2. Git 差异洁净度检查
> git diff --check
(0 trailing whitespace, 0 syntax defects, Exit Code: 0)

# 3. 40-case 评测基准套件
> node scripts/run-eval.mjs
{
  "schemaVersion": 1,
  "mode": "lexical",
  "passed": 40,
  "total": 40,
  "passRate": 1.0,
  "p95Ms": 98,
  "failures": []
} (Exit Code: 0)

# 4. 全量自动化测试套件
> npm test
ℹ tests 129
ℹ suites 0
ℹ pass 129
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 32871.6885 (Exit Code: 0)

# 5. 代码覆盖率测试
> npm run test:coverage
ℹ all files | line: 84.85% | branch: 74.98% | funcs: 85.62% (Exit Code: 0)

# 6. npm 打包发布干跑验证
> npm run pack:check
npm notice total files: 97
npm notice unpacked size: 507.1 kB
codex-obsidian-second-brain-0.2.0.tgz (Exit Code: 0)
```

---

## 三、 环境卫生与零残留保证 (Workspace Hygiene)

- 本次整改过程中产生的所有调试临时目录与 Python 字节码缓存已在收尾阶段主动彻底清理。
- 当前代码仓库 `git status` 仅包含正式提交的代码变更、Schema 定义、规则排除文件与对应的测试用例套件，没有任何未跟踪的临时垃圾文件，完全符合零残留原则。

---

## 四、 交付建议与结论

所有在《第二次独立复审报告》中指出的关键缺陷、边缘反例和潜在风险均已完成第一性原理的技术收敛，并通过了严格的故障注入与表驱动测试。当前版本已具备发布就绪（Release Ready）状态，建议批准合并。
