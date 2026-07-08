# Role Memory Forge v0.4.4

SillyTavern 角色卡记忆插件：分层总结、实时填表、关系网络图、世界书同步、历史聊天补录、走马灯回顾。

## v0.4.4 更新重点

1. **API 保存按钮**
   - 在悬浮面板的「API 与模型」里新增「保存 API 配置」。
   - API 地址、Key、模型名可以手动保存，保存后会立即写入 SillyTavern 扩展设置。
   - 本地 OpenAI-compatible 接口可以不填 Key。

2. **模型列表拉取**
   - 新增「拉取模型」按钮。
   - 会请求 `API 地址/v1/models` 或从 `/chat/completions` 自动换算到 `/models`。
   - 拉取后可直接在「模型选择」下拉框里选模型，也保留手动填写模型名。

3. **人物关系图缩小优化**
   - 缩小中心头像、周围头像、关系文字和整体画布高度。
   - 避免关系图挡住人物名、关系标签或下方数据表。

4. **向量化记忆暂不默认加入**
   - 当前版本优先做「分层总结 + 世界书注入 + Index 数据表」。
   - 向量化适合超长聊天语义召回，但会增加 embedding API、存储和召回误差。
   - 建议等历史补录、世界书、关系图完全稳定后，再在 v0.5.x 做可选向量召回。

## 安装

把本仓库上传到 GitHub，确认根目录包含：

```text
manifest.json
index.js
style.css
README.md
LICENSE
```

然后在 SillyTavern：

```text
扩展程序 → 安装扩展程序 → 粘贴 GitHub 仓库地址
```

更新旧版后建议：

```text
电脑 Ctrl + F5 强刷
手机清缓存后重新进入酒馆
```
