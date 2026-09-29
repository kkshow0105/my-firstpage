# PWA v1.1.0 更新流程复测

日期：2026-09-29。开发基线：060166ef067ab19766fea3e681d1d22fdd1d399e。

## 本轮范围

应用菜单显示版本由 v1.0.0 升至 v1.1.0，README 同步说明。Service Worker 缓存由 shuangbiao-v4 升至 shuangbiao-v5。

LocalStorage v6、备份 version:2、manifest 的起始路径和作用域均未修改。本轮未修改订单、库存、采购、财务、迁移、恢复、导入导出、输入及多窗口架构。README 的单记账窗口限制保留。

## 更新流程

- 页面注册完成后检查已有 reg.waiting，同时监听 updatefound 和 installing worker 的 statechange。
- 仅已有 controller、worker 完整安装成功并处于 waiting 时展示“发现新版本”。首次安装和正常无更新刷新不展示。
- 新 worker 的 install 不再自动 skipWaiting；旧页面继续使用。
- 点击“立即更新”发送明确的 SKIP_WAITING 消息；SW 的 message 处理执行 skipWaiting。
- 新 SW activate 完成并 clients.claim 后触发 controllerchange。页面仅在用户发起更新时刷新，updateReloaded 保证最多一次，首次安装接管不刷新。
- “稍后”只在当前页面忽略同一个 worker；再次发现另一个新 worker 可重新展示。
- 更新提示位于主要操作按钮上方，390×844 与桌面均完整，打印隐藏。
- 如果处于恢复保护，更新按钮先要求保留恢复资料并恢复记账，不刷新掉仅存在内存的操作前快照。没有修改恢复保护的原实现。

事件使用浏览器原生 API，参照 [updatefound](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/updatefound_event)、[skipWaiting](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerGlobalScope/skipWaiting) 和 [controllerchange](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerContainer/controllerchange_event)。

## FA-07 保护

原 cache.addAll(PRECACHE_URLS) 和 install event.waitUntil 保留。核心页面/manifest 必须全部缓存成功；失败不产生可更新的 waiting worker，不接管，不运行旧缓存清理。

新增真实测试中：v6 正常运行，模拟 v7 核心缓存 503，失败 worker 为 redundant，原 active 对象不变，更新提示隐藏、没有 waiting worker，v6 缓存保留。将服务器切换为断开连接并刷新，旧页面 v1.1.1 及原订单仍可读取。

失败尝试可能留下空的 v7 Cache 容器（caches.open 的结果），不代表缓存成功；不影响旧版本离线启动。

## 永久新增测试

新增 tests/pwa-update.cjs，共 12 组，实际使用本机 Edge + CDP，没有安装依赖或下载浏览器。

1. 首次安装成功，无更新提示，无多余刷新。
2. 正常刷新，没有 waiting 时无提示。
3. 新 worker 成功安装并 waiting，旧页面保持原 controller，仍能新增订单。
4. 390×844 和 1100×844：实际提示/按钮边界完整，不与新增/采购按钮重叠，截图验证；打印媒体下隐藏。
5. “稍后”关闭当前提示，同一 worker 不重复提示。
6. 打开页面时已有 waiting worker，仍能展示。
7. 真实鼠标点击“立即更新”→记录明确消息→真实 SW 激活→controllerchange→刷新。额外注入重复 controllerchange 事件，实际页面加载数仅增加 1，订单保留。
8. 更新后只删除本应用旧缓存，another-app-test、ordinary-cache 仍存在。
9. 核心缓存失败→无提示/无 waiting→旧 worker/旧缓存保留→离线刷新链路。
10. 同一页面“稍后”之后发布另一个新 worker，提示再次出现。
11. 恢复保护时不因更新丢失内存快照。
12. 页面 JavaScript 异常为 0。

命令：`node tests/pwa-update.cjs`。PWA_ARTIFACT_DIR 可保留截图和结果；默认成功后清理测试临时目录。

## 完整回归

| 实际执行命令 | 通过 | 失败 |
|---|---:|---:|
| node tests/data-safety.cjs | 79 | 0 |
| node tests/inventory-interactions.cjs | 33 | 0 |
| node tests/input-boundaries.cjs | 110 | 0 |
| node tests/print-ui-metadata-sw.cjs | 36 | 0 |
| node tests/final-single-window.cjs | 25 | 0 |
| 原基线合计 | **283** | **0** |
| node tests/pwa-update.cjs | **12** | **0** |
| 全部合计 | **295** | **0** |

原 283 组未删减，业务断言未修改。两个包含 SW 的既有测试仅适配当前缓存名、失败升级的模拟下一版本号，以及缓存清理测试中的明确确认消息；不再依赖新 worker 自动强制接管。

截图 update-390.png、update-1100.png 已实际查看。提示与按钮清晰，主操作可点击。既有打印专项仍实际生成/解析 A4 PDF 并全部通过。

测试日志/截图存于项目外：C:/Users/84463/.codex/visualizations/2026/09/27/01a0e546-96b5-7030-8919-487efc5142a2/pwa-update-review/。

## 文件与结果

修改：index.html、sw.js、README.md、tests/final-single-window.cjs、tests/print-ui-metadata-sw.cjs。
新增：tests/pwa-update.cjs、本报告。

git diff --check 通过，项目内无临时测试资料，未发现新的回归。原未跟踪 FINAL-INDEPENDENT-AUDIT.md 保留原文。未 commit、push 或部署。

提示功能从已加载 v1.1.0 代码的页面开始生效。已打开的 v1.0.0 页面没有提示代码，首次取得本功能需刷新或关闭重开；以后可在提示条内确认升级。
