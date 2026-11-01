# 双表记账

当前应用版本：v2.0.1。原生 HTML / CSS / JavaScript + LocalStorage + Service Worker，无后端、无新增依赖。

## 行程与备份

顶部可直接新建、切换行程；管理中可重命名、开始行程、归档、重新启用和删除。新行程默认待出发，可直接录入客户预订。同名行程使用不同的固定 ID。归档行程保留数据，可查看、打印和导出，重新启用后可编辑。删除行程需要两次确认；删除最后一个行程后会建立一个空行程。

订单、采购流水、商品资料、库存和财务都按行程独立保存。采购地点仍只作参考，不参与库存分配。菜单中的清空仅针对当前行程。

- **导出当前行程**：备份 `version: 3, type: "trip"`，含完整 `trip` 对象及导出时间。
- **导出全部行程**：备份 `version: 3, type: "all-trips"`，含全部 `trips`（包括归档行程）和 `activeTripId`。
- **导入旧版备份**：兼容 v6 的 `version: 2` 完整备份，以及 v5 的 `version: 1` 备份。v5 系统库存行须与采购流水完整核对才可转换，缺失的收款状态按未收款恢复；异常数据拒绝导入。必须先指定已有行程或填写新行程名，再确认替换。相同旧备份选择新建时使用内容生成的稳定 ID，重复导入会提示替换，避免重复新建。
- **导入新版单行程**：按 ID 匹配；同名不同 ID 不会误覆盖。确认后仅替换或新建该行程。
- **导入全部行程**：先列出新增、替换、删除的行程，确认后完整恢复，不逐条合并。

恢复前会自动保留最近一次安全副本，菜单可导出。安全副本写入失败时取消恢复。文件有损坏、未知版本或非法数量时拒绝导入，原账本不变。

## 本地存储与迁移

`dual_table_trip_book_v1` 保存 `{schemaVersion: 1, revision, commitId, migration, trips}`。每个行程含固定 `id`、`name`、`status`（`planned/active/archived`）、创建/更新时间、`orders`、`purchaseLogs`、`productMeta`。所有行程作为一个存储项一次写入，避免三份数据只保存一部分。

`dual_table_active_trip_v1` 记住最近选择；每个已打开的窗口仍独立保持自己的当前行程。`dual_table_restore_safety_v1` 保存最近一次恢复前的完整备份和原始存储内容。

首次升级先沿用现有 v5→v6 迁移及其 pending/complete 恢复日志，再创建“历史账本”。迁移前后校验订单/采购笔数、需求、应收/未收、采购成本及各商品采购/分配量。新账本数据和迁移完成标记在同一次写入中保存，失败可重试，不会重复追加订单。原来的三个 v6 键及 v5 历史数据不会在行程记账中被覆盖或删除。损坏的新账本不会自动回退到陈旧的旧账本。

## 多窗口与离线

保存前核对存储版本，检测到其他窗口更新时取消本次保存并刷新数据，同时关闭全部待保存弹窗及导入操作。检测到同修订号或过期版本的同时提交时暂停记账，保留本窗口完整快照和冲突原始数据，提示先导出核对；旧版本窗口写入旧键也会触发保护。

这属于版本检测和冲突恢复，不是多人协作或自动合并。仍推荐只在一个窗口录入；若出现冲突提示，请先导出页面上的两份恢复资料，导出前不要关闭或刷新该窗口。LocalStorage 及恢复前安全副本都在浏览器内，清除网站数据会丢失本地资料，请定期导出全部行程。

新版本安装完成后显示“发现新版本”，点击“立即更新”后切换并刷新一次；“稍后”可关闭本次提示。首次安装及核心缓存失败时不会提示更新。

Service Worker 缓存版本升级为 `shuangbiao-v7`。记账脚本继续内嵌在 HTML 中，避免旧缓存切换期间 HTML 与外部脚本不配套。离线时可切换、录入、保存和刷新。

## 自动化测试

使用本机 Edge + Node 22 的 CDP；不安装浏览器、不新增 npm 依赖。打印测试使用已有 Python + pypdf，可用 `PDF_PYTHON` 指定。

```powershell
node tests/data-safety.cjs
node tests/inventory-interactions.cjs
node tests/input-boundaries.cjs
node tests/print-ui-metadata-sw.cjs
node tests/final-single-window.cjs
node tests/pwa-update.cjs
node tests/multi-trips.cjs
```

测试使用独立临时浏览器和随机本地地址，不读取实际使用中的账本。人工验收及本次回归说明见 [MULTI-TRIP-RETEST.md](MULTI-TRIP-RETEST.md)。

手动验证旧备份可使用 [tests/fixtures/legacy-v6-backup.json](tests/fixtures/legacy-v6-backup.json)。历史格式依据、v5 补充文件及核对数字见 [tests/fixtures/README.md](tests/fixtures/README.md)。
