# pi-skill-evolution

给 Pi Agent 的 Hermes Agent 风格自动技能进化扩展。

Pi Agent 已经有很好的技能系统和扩展 API，但缺少"自动创建/修改/进化技能"的闭环能力——这正是 Hermes Agent 通过 `background_review` 和 `skill_manage` 实现的核心特性。本仓库在 Pi 的 event-driven 架构上补齐这块拼图。

## Review 频率

### Background review loop

默认每 10 次 settled turn 触发一次 review（比 3 次更节制，避免刷屏；比 25 次更紧凑，不丢失上下文）。同时支持手动触发：`/skill-evolution review now`。

消息已精简为**单行带时间戳**，不会把会话输出刷乱。

## 安装

### 通过 npm（推荐）

```bash
pi install npm:pi-agent-skill-evolution
```

Pi 会自动发现并加载扩展和技能，无需任何设置变更。

### 直接复制（最轻量）

```bash
# 扩展
cp extensions/skill-evolution.ts ~/.pi/agent/extensions/

# 技能（写作指导，非必需）
mkdir -p ~/.pi/agent/skills/skill-authoring
cp skill-authoring/SKILL.md ~/.pi/agent/skills/skill-authoring/
```

Pi 会自动发现并加载。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PI_SKILL_EVOLUTION_DIR` | `~/.pi/agent/skills/` | 技能存储目录 |

更多细节见 [README.md](README.md)。

## 新增功能：使用统计与不活跃提醒（v0.1.2+）

本扩展增加了技能使用次数记录和每周不活跃提醒功能：

- 每次 `skill_manage` 调用自动记录使用次数和时间戳
- 每 7 天检查一次超过 30 天未使用的技能，通过 follow-up 消息提醒用户
- 使用 `/skill-evolution reminder on/off/status/check` 管理提醒开关（持久化）
- 使用 `/skill-evolution disable <name>` / `enable <name>` 禁用/启用技能
- 使用 `/skill-evolution stats` / `inactive` 查看统计和不活跃技能
