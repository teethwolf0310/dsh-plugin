# dsh-plugin

DeepSeek Harness (dsh) 自研插件集。

## 插件目录

| 插件 | 描述 | 状态 |
|---|---|---|
| [token-stats](./token-stats) | 持久化 token 用量统计：按轮次/会话/工作区/时间窗，JSONL 落盘，提供 `ctx.tokenStats` 服务、`token_stats` 模型工具、`/tokens` 命令 | active |

## 安装

DeepSeek Harness 0.1.0-rc.6+。每个插件独立打包，profile 二选一（web / desktop）：

```sh
# 例：安装 token-stats 到 web profile
dsh plugin --profile web add "github:teethwolf0310/dsh-plugin#token-stats"

# 桌面端
dsh plugin --profile desktop add "github:teethwolf0310/dsh-plugin#token-stats"
```

安装后重启 `dsh web`/桌面端生效。

## 文档

- DeepSeek Harness：https://github.com/deepseek-ai/deepseek-harness
- 插件生态 topic：https://github.com/topics/dsh-plugin

## License

MIT
