# dsh-plugin

DeepSeek Harness (dsh) 自研插件集。

## 插件目录

按字母序排列。每个插件独立目录、独立 `package.json`（`dsh.bundle` manifest）和文档。

| 插件 | 描述 | 状态 |
|---|---|---|
| _（待添加）_ | | |

## 安装

DeepSeek Harness 0.1.0-rc.6+，宿主为 `dsh web` 或桌面端，profile 二选一（web / desktop）：

```sh
# web profile
dsh plugin --profile web add "github:teethwolf0310/dsh-plugin#<subdir>"

# 桌面端 profile
dsh plugin --profile desktop add "github:teethwolf0310/dsh-plugin#<subdir>"
```

安装后重启 `dsh web`/桌面端生效。

## 开发

Node.js 18+。每个插件简化为 `cordis` 插件的标准结构：

```
<plugin-name>/
  dsh.bundle.json   # 清单（或无独立文件，走 package.json 的 dsh.bundle 字段）
  package.json
  src/
  README.md
```

发布前先在本机 `dsh plugin --profile web add .` 自测。

## 文档

- DeepSeek Harness 主仓库：https://github.com/deepseek-ai/deepseek-harness
- 插件发现 topic：https://github.com/topics/dsh-plugin

## License

MIT
