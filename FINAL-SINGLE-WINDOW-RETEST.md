# FA-03～07 单窗口收尾复测报告

日期：2026-09-29。基线提交：8851dd137ca794549cba363f703f0964310e26ae。

本轮只修改 FA-03～07。未改保存架构、库存分配、迁移或多窗口同步机制，未 commit、push、部署。

## 已知使用限制

双表记账目前按单记账窗口使用设计，不支持多个窗口同时编辑账本。

FA-01（并发保存覆盖）、FA-02（跨窗口同步后普通编辑弹窗过期）按用户决定保留，不能宣称全部审查问题归零。README.md 已明确说明。

## 修改前复现、根因和修复

| 问题 | 本轮修改前实际复现 | 根因 | 最终修复及结果 |
|---|---|---|---|
| FA-03 | 从商品汇总点击备注按钮，保存 OLDNOTE；刷新建立旧备注，再实际点击按钮保存 NEWNOTE；不刷新打印。存储为 NEWNOTE，客户清单仍 OLDNOTE，商品清单为 NEWNOTE。 | confirmProductNote 只重绘商品汇总，客户区域打印 DOM 没更新。 | index.html:2156 的保存成功路径使用 renderAll；存储及两处备注一致，真实 PDF 中 NEWNOTE 出现两次，OLDNOTE 不再出现。 |
| FA-04 | CDP 真实 Enter 协议：快速连续及 autoRepeat 重复各出现 9 单；Enter 后触发确认出现 2 单。单次 Enter、鼠标双击、下一份草稿原本未稳定复现重复。 | 确认函数只读输入值，没有已消费草稿状态；弹窗关闭后残余键盘事件仍能保存。 | index.html:1995 起增加 addDraftActive；打开为 active，成功持久化后立即失效，关闭/点遮罩也失效，失败仍可重试。不是延时防抖。重复事件只保存一次，新草稿正常。 |
| FA-05 | 390×844 和桌面真实文字 Range 测量：999.99 及更大售价侵入付款框；12345.67 的文字右边达到 293.59px，付款框占 274～294px。 | 46px 售价列不足，内联点击元素没有内容宽度约束，并有负边距。 | index.html:170 起售价列 78px，数字点击元素限宽、取消负边距、可折行；合计行按 3+3 列分配，长金额可换行。五档价格完整，文本右边 264px，付款框左边 274px，间隔 10px。 |
| FA-06 | 搜索 AAA 后实际点击编辑并保存 AAA-EDIT，输入框还是 AAA，BBB 却出现；商品汇总搜索后保存备注同样失去过滤。 | 重绘替换 DOM 后没有重新应用当前查询。 | index.html:1288 的 reapplySearch 在两个表格渲染后按当前页静默重应用；不重复 toast/定位。最后一个匹配被改名后保持空结果。打印 CSS 仍输出完整账单，BBB 在 PDF 中保留。 |
| FA-07 | 用真实 SW v4 建立离线缓存，再提供 v5 worker 并令必要资源返回 503；原实现仍 activated，v4 缓存被删。 | install 对每个失败 catch，再 allSettled，导致 waitUntil 总成功并 skipWaiting。 | sw.js:24 改为 cache.addAll，必要资源全部成功才 skipWaiting。失败安装为 redundant，原 active worker 对象不变，v4 缓存保留；服务器断网后刷新仍加载旧应用。 |

## 永久专项测试

新增 tests/final-single-window.cjs，共 **25 组，通过 25，失败 0**：

- 1 组：真实备注编辑/保存按钮 → 存储/两处 DOM/PDF 比较。
- 8 组：单次 Enter、快速连续、长按 repeat、Enter 后重复确认、真实鼠标双击、下一份草稿、保存失败后重试、关闭草稿后禁止提交。
- 10 组：390×844、1100×844 各测试 35.50、999.99、1234.56、9999.99、12345.67；测量真实文本 Range 与付款控件，检查裁切和遮挡。
- 3 组：两张表搜索→实际编辑/保存→过滤保持且完整打印；修改最后匹配项及直接 renderCustomers/renderAll 后仍保持过滤。
- 2 组：正常 SW 安装/离线刷新；核心预缓存失败→原 worker/缓存→断网刷新。
- 1 组：页面 JavaScript 异常为 0。

测试使用本机已安装 Edge + CDP、隔离来源和浏览器配置目录，没有下载浏览器或安装依赖。键盘使用 Input.dispatchKeyEvent；鼠标使用 Input.dispatchMouseEvent。Enter 后重复确认另主动触发一次隐藏按钮 click，验证状态保护不依赖按钮可见性。

运行：`node tests/final-single-window.cjs`。可用 PRINT_ARTIFACT_DIR 保留截图/PDF；未指定时成功后清理临时输出。

## 原有稳定基线

| 实际执行命令 | 通过 | 失败 |
|---|---:|---:|
| node tests/data-safety.cjs | 79 | 0 |
| node tests/inventory-interactions.cjs | 33 | 0 |
| node tests/input-boundaries.cjs | 110 | 0 |
| node tests/print-ui-metadata-sw.cjs | 36 | 0 |
| 原基线合计 | **258** | **0** |
| 新专项 | **25** | **0** |
| 总计 | **283** | **0** |

原测试断言和组数未减少。四个测试脚本的新增订单准备步骤补上 openAddModal/showAddStep，输入边界脚本的两个手工入口也打开草稿，以适配已验收的真实草稿生命周期。

数据安全脚本首次运行停滞，其专用 Edge 自动加载了扩展欢迎页及同步页。为隔离测试，在该脚本启动参数增加 --disable-extensions、--disable-sync，随后完整独立重跑 79 组通过。其他测试脚本原本已有这些参数。不把停滞那次算作通过。

既有回归覆盖新增、快速输入、编辑、删除（鼠标/移动触摸残余事件）、采购与库存、付款、导入导出、刷新/重启、恢复锁、迁移、输入边界和打印。

## 移动截图与 PDF 验证

五张 390×844 价格截图已逐一实际查看。数量 12、已采 0/12、五档售价、付款框和待付款合计均完整可见，不互相覆盖。桌面同样通过文字/控件矩形检测。

新专项实际生成 3 份 A4 PDF，均为 1 页：新商品备注、客户搜索后编辑、商品搜索后编辑。解析验证新备注在两张清单一致、隐藏的 BBB 仍完整打印、大金额和关键字段保留；渲染为图片并检查排版。

原打印专项再次实际生成 A4 PDF：2 单 1 页、10 单 1 页、100 单 7 页、长名称 1 页、长备注 2 页。检查首页正文、每个商品在两张表各出现一次、页面非空、金额及数量完整。其他备注和筛选 PDF 也全部通过。

## PWA 失败升级验证

正常安装后 controller 存在，断网刷新应用可用。模拟升级到 v5 时，SW 脚本可取得、核心资源全部返回 503；新 worker 最终 redundant，原 active 对象不变。Cache Storage 保留 shuangbiao-v4；可能留下空的 shuangbiao-v5 容器，这是 caches.open 的结果，不代表安装成功，不影响旧版本离线运行。随后让服务器连接失败并刷新，实际仍可打开旧应用。

当前三个 PRECACHE_URLS 均作为必要资源；没有引入可选资源、更新提示或缓存架构改造。

## 文件、证据与范围

正式代码：index.html、sw.js。使用说明：README.md。既有测试适配：四个 tests/*.cjs。新增：tests/final-single-window.cjs、本报告。

本轮证据在项目外：C:/Users/84463/.codex/visualizations/2026/09/27/01a0e546-96b5-7030-8919-487efc5142a2/final-fixes-review/，其中 before 为修改前失败证据，after 为最终专项结果/截图/PDF，baseline-pdf 为基线打印输出，根目录四份日志记录原 258 组。

FINAL-INDEPENDENT-AUDIT.md 是开始本轮时已经存在的未跟踪文件，本轮保留原文。

本轮未发现新的业务回归。git diff --check 通过；项目内未留下临时浏览器配置、截图、PDF 或测试数据。FA-01/02 仍是已知限制。
