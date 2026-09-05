# pi-skill-evolution

为 Pi Agent 提供安全的 skill package 管理和隔离的 skill evolution review。

## 架构

- 隔离 reviewer 分析已完成的 agent runs，并生成 proposal。
- `skill_manage` 读取 skill package，并执行受保护的文件修改。
- Reviewer 不能直接修改 skill。

## Review loop

每个 session 单独统计 `agent_settled`。一次 `agent_settled` 表示一个 agent run 已完全结束并进入 idle；run 内的 tool calls 不单独计数。

每 10 个完成的 runs，extension 会：

1. 读取下一个不重叠的 10-run 窗口；
2. 移除图片、疑似 secret 和过大的值；
3. 在独立 model context 中选择相关 skills；
4. 只加载相关 skill bodies；
5. 生成最多三个 JSON proposals。

Reviewer 使用配置的 `reviewModel`，否则使用当前 model。Reviewer 的 prompt 和 response 不进入主 conversation context。没有 proposal 时不显示消息。

手动检查：

```text
/skill-evolution review now
```

## Proposal

```text
reviewer -> pending proposal -> human apply/reject -> transaction
```

Proposal 使用 source hashes 防止覆盖新修改。状态包括 `pending`、`applied`、`rejected` 和 `stale`。多文件 apply 失败时会回滚。

```text
/skill-evolution proposal list
/skill-evolution proposal show <id>
/skill-evolution proposal apply <id>
/skill-evolution proposal reject <id>
```

## Scope

- global：`~/.pi/agent/skills/<name>/`
- project：`<cwd>/.agents/skills/<name>/`

Project 操作要求 trusted project。写操作必须明确指定 scope。两个 scopes 不能创建相同的 skill name。

## `skill_manage`

- `list`、`inspect`：读取操作。
- `patch`：不需要 proposal，但只能修改 `SKILL.md` body 中唯一匹配的文本。
- `create`、`edit`、`write_file`、`delete`：需要有效的 `proposalId`。
- `delete` 表示 disable，不会永久删除 package。

永久删除只能由用户执行：

```text
/skill-evolution purge global|project <name>
```

## 配置

Global：`~/.pi/agent/skill-evolution/config.json`

Project：`<cwd>/.pi/skill-evolution/config.json`

```json
{
  "reviewModel": "google/gemini-2.5-flash",
  "reviewInterval": 10,
  "maxProposals": 3,
  "inactiveDays": 30
}
```

## Statistics

统计分为：

- `explicitInvocation`：调用 `/skill:name`；
- `skillLoad`：读取对应 `SKILL.md`；
- `managementOperations`：读取或修改 package。

只有 invocation 和 load 表示 skill 活跃。旧 `.skill-stats.json` 会直接删除，不迁移。

## Skill authoring

`skill-authoring` 是 user-invoked skill，不进入默认 system context：

```text
/skill:skill-authoring
```

Create、description 或 invocation mode 修改、disable、enable、purge 后，请手动执行 `/reload`。
