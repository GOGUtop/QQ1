# Role Memory Forge / SillyTavern 角色记忆插件

这是一个为 SillyTavern 制作的第三方 UI 扩展，用来做“分层记忆 + 实时填表 + 世界书保存 + Prompt 注入”。

## 功能

- 每次 User 与角色 AI 完成一轮对话后，自动用简略语言记录一条“每层简记”。
- 每 20 条简记自动生成一次“阶段总结”（可在设置里改）。
- 每 5 个阶段总结自动合并为“大总结”（可在设置里改）。
- 每次生成前把“当前大总结 + 大总结之后的阶段总结 + 最近简记 + 状态表”注入给 AI。
- 实时维护：角色状态、人物档案、人物关系、世界设定、物品栏、约定、当前剧情、发展方向、可视化关系表。
- 自动把记录写入当前角色对应的世界书：
  - `[RMF] 00 当前记忆总览`
  - `[RMF] 01 每层简记流水`
  - `[RMF] 02 可视化关系表`
  - `[RMF] 99 JSON_RAW_DO_NOT_EDIT`
- 关闭插件时可自动清理当前记忆。
- 新聊天默认清空记忆；也可以开启“新聊天保留这张角色卡的旧记忆”。
- 支持两种总结模型来源：
  - 使用 SillyTavern 当前 API（推荐）
  - 自填 OpenAI-compatible API 地址、Key、模型名

## 安装

1. 把本项目上传到 GitHub，例如：`https://github.com/你的用户名/SillyTavern-RoleMemoryForge`
2. 打开 SillyTavern。
3. 顶部菜单进入 `Extensions / 扩展`。
4. 选择 `Install Extension / 安装扩展`。
5. 粘贴你的 GitHub 仓库地址。
6. 安装后刷新页面。
7. 在扩展设置里找到 `Role Memory Forge`，打开“启用记忆插件”。

## 推荐设置

推荐先选择：

- 总结来源：`使用 SillyTavern 当前 API（推荐）`
- 每多少条简记生成阶段总结：`20`
- 多少个阶段总结生成大总结：`5`
- 注入深度：`4`
- 最大注入字符：`9000`
- 最近简记注入数量：`8`

如果你要接硅基流动、OpenRouter、本地模型等 OpenAI-compatible 服务，可以选择“自填 OpenAI-compatible 地址/密钥/模型”。示例：

- `https://api.siliconflow.cn/v1`
- `http://127.0.0.1:8000/v1`
- `https://openrouter.ai/api/v1`

注意：自填 API Key 会保存在 SillyTavern 扩展设置里；如果 API 服务不允许浏览器跨域请求，可能会被 CORS 拦截。遇到这种情况请改用“使用 SillyTavern 当前 API”。

## 世界书说明

插件会自动创建类似 `RMF-角色名-记忆世界书` 的世界书，并把记忆条目写进去。实际每次注入给 AI 的记忆由插件的 `setExtensionPrompt` 完成，不完全依赖世界书关键词触发，所以更稳定。

## 向量化需要吗？

这个插件第一版不内置向量化。原因：

- 你的需求是“确定性分层总结 + 每次都发送总结”，总结链已经能解决长期剧情连续性。
- 向量化适合超长聊天里按语义检索旧片段，但会增加 embedding 成本、配置复杂度和误召回。
- 如果你的聊天超过几千轮，并且经常需要找很久以前的某个细节，再考虑接 SillyTavern 自带的 Chat Vectorization / Vector Storage。

建议：先用本插件的分层总结。等聊天量非常大后，再加向量化作为“检索旧细节”的补充，不要一开始就开。

## 维护建议

- 编辑或删除旧消息后，点击“补录当前聊天”，避免简记与正文不一致。
- 如果发现模型胡乱总结，点击“清空当前记忆”后重新补录。
- 不要手动编辑 `[RMF] 99 JSON_RAW_DO_NOT_EDIT`，否则跨新聊天恢复可能失败。

## 文件结构

```text
SillyTavern-RoleMemoryForge/
├─ manifest.json
├─ index.js
├─ style.css
├─ README.md
└─ LICENSE
```
