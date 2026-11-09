# askagent / execagent · DSH 侧栏提问与执行子代理

在 DeepSeek Harness（DSH）里，从界面**手动开一个子代理会话**：选中一段内容、写一个问题或任务，
插件通过 DSH 的 subagent 运行时把它派出去。

同一个 Host 插件提供两种投递策略：

| 模式 | 触发 | `delivery` | 子代理行为 |
| --- | --- | --- | --- |
| **askagent**（问） | `notifyParent` 缺省 / `false` | `caller` | 回答只留在这个子代理会话里；插件把子代理**静音**：移除 `send_message` 工具、注入「不要联系父代理」的系统提示，冷启动/恢复后仍保持静默 |
| **execagent**（执行） | `notifyParent: true` | `parent` | 结果回投主会话并唤醒主代理，等于把这段内容当任务派出去 |

askagent 是「右侧栏提问」：不打断主对话，父代理永远收不到消息；
execagent（exec）是「派活」：任务在子代理里跑，结论自动回投主会话。

## 组成

- **本仓库 = Host 半侧**：消费 `webServer` / `subagents` / `agents` 服务，暴露 `/askagent` 路由，
  负责创建 continuable 子代理、维护静默注册表、在 `subagent/start` 事件上重新施加静默。
- **Client 半侧（弹出菜单 / 兼容菜单）在 [`dsh-quick-quote`](https://github.com/sprw-li/dsh-quick-quote)**：
  选中文字时浮出的 `引用文本 | 问 | 执行` 胶囊、侧栏提问面板、以及按 host 能力降级的兼容菜单都住在那里。
  两个插件可以分开安装；只有本仓库时可以直接用下面的 HTTP API。

## 安装

在 DSH profile 目录里（例如 `~/.dsh/profiles/desktop`）：

```bash
pnpm add link:/path/to/dsh-askagent
```

然后在 profile 的 `package.json` 里把包名加进 `dsh.profile.bundles`：

```json
"dsh": { "profile": { "bundles": ["@local/askagent"] } }
```

DSH 会重新组合插件（HMR）；没有热更新时重启 DSH。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/askagent` | `{ providers: [{ name, continuable }], silent: [childId…] }`，用于探活与查能力 |
| `GET` | `/askagent/providers` | 同上（只给 provider 列表） |
| `POST` | `/askagent` | 入参 `{ sessionId, prompt, label?, notifyParent? }`；返回 `{ childId, provider, label, delivery }` |

`POST` 示例：

```bash
curl -X POST http://127.0.0.1:<webPort>/askagent \
  -H 'content-type: application/json' \
  -d '{"sessionId":"session-…","prompt":"帮我查一下这个 API 的用法","label":"askagent · API 用法"}'
```

- `notifyParent: false`（默认）→ askagent：`delivery: 'caller'`，子代理被静音；
- `notifyParent: true` → execagent：`delivery: 'parent'`，结果回投并唤醒主会话。

`prompt` 由调用方自己组好（例如「引用原文 + 用户问题」），插件不再包一层。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DSH_ASKAGENT_HOME` | 系统临时目录下的 `dsh-askagent/` | 诊断日志 `askagent.log` 与静默注册表 `askagent-silent.json` 的位置；想跨重启保留就指到一个持久目录 |

静默注册表保存所有 askagent 子代理 id（最多 800 条），用于 DSH 重启后把老会话重新静音；
日志用于事后排查派发失败。

## 实现要点

- 优先选择注册了 `prepareContinuable` 的 subagent provider，保证子代理可以续聊。
- 子代理保留 subagent 语义：`parentSession` 血统、`origin: 'subagent'`（不出现在工作区会话列表）、
  走普通 Session 事件日志（轨迹、导出都正常）。
- 静默通过 `tools.restrict({ deny: ['send_message'] })` + `tools.guard` + `systemPrompt.section`
  三重施加；`subagent/start` 时按 id 命中则重施，命中不了再延时 250ms 重试一次。
- 插件卸载时 abort 所有由它启动的 activation。

## 已知限制

- 只支持**可续聊**（continuable）的 provider；没有的话 `POST /askagent` 直接报错。
- `sessionId` 必须指向一个**活着的** Agent（宿主会话）；子代理会话不能再派生子代理。
- 静默靠工具限制 + 提示，不是安全边界：子代理若被额外授予发送通道，插件不会二次拦截。
- 诊断日志无轮转。

## 许可

MIT
