# Role Memory Forge v0.4.3

SillyTavern 角色卡记忆插件：分层总结、实时填表、关系网络图、世界书同步、历史聊天补录、走马灯回顾。

## v0.4.3 修复重点

1. **人物关系图兜底生成**
   - 之前模型只返回简记、不返回 `relationships` 时，关系图会一直空。
   - 现在即使模型没填关系，也会根据 user/AI 的每轮互动自动生成基础关系线。
   - 9 层简记以后也能看到中心角色、外围角色、连线和关系卡片。

2. **Index 数据表真正写成 ACU 可读结构**
   - 旧版世界书里是 `0 / 1 / 2` 表编号，shujuku/TavernDB-ACU 不一定识别。
   - 现在改成 `sheet_0 / sheet_1 / sheet_2`，并保留 `mate: { type: chatSheets }`。
   - 同时会把表格数据写入最新 AI 楼层的 `TavernDB_ACU_IndependentData / TavernDB_ACU_Data / TavernDB_ACU_SummaryData`，更接近 shujuku 自己的存储方式。

3. **面板 Index 表展示增强**
   - 面板里现在直接显示：人物关系表、关系图节点表、关系图连线表、角色状态表、人物档案表、物品栏表、剧情进度表、简记流水表、阶段总结表。

4. **新增两个开关**
   - `同步到聊天楼层 ACU sheet_* 数据`
   - `关系图没数据时自动兜底建图`

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
