# dsh-install-check

中文名：**插件无忧装**

> 看到感兴趣的直接丢过来装吧，别的我们替你思考。

DSH 装插件前的自动体检。你说「装 X」，它先读 X 的代码，和已装的插件比一遍；真撞上了、真缺东西了，才说一句，并给出建议。

不拦截，不改你的配置，不自动帮你装依赖。

## 它长什么样

装上 `kid-memory` 时，装完立刻说一句：

> 和 dsh-lite-memory 都注册工具 memory_save，模型只会看到一个。
>
> 可以照装，功能有重叠，坏不了。

真会顶掉别人的（同一个加载行 id 或服务键），装之前先问：

> 和 dsh-lite-memory 都提供 memoryStore 服务，后装的会顶掉它。
>
> 建议先停用 dsh-lite-memory 再装；直接装不会崩，只是会盖掉它。

你说「照装」就装，说「算了」就不装。工具名、路由、依赖的重叠从不拦安装，只提示。

## 它看什么

静态读包，不执行候选插件的代码：

- 加载行 id（`cordis.patch.yml`）
- 服务键（`provide` / `ctx.set`）
- 工具名（`defineTool` / `tools.register`）
- 路由前缀、slot
- 插件之间的 `peerDependencies` 没装

## 安装

```bash
dsh plugin install dsh-install-check
```

或者直接对模型说「装 dsh-install-check」。

只装一次就一直在，之后你说「装 xxx」时自动生效，不需要先问它。

## 边界

- 只报读得到的东西：运行时拼出来的名字、动态注册的工具看不到
- 依赖只报 `peerDependencies`；通过服务懒取的依赖暂不提示
- 支持 npm 包名和本地路径；拉不到包时安静放行，不打扰你
- 只在安装和启用时出现，平时不占地方

## 开发

```bash
node --test test/
node scripts/scan-market.mjs names.txt
```

`names.txt` 一行一个包名，用来量一量某个品类实际撞名率。

## License

MIT © regrevia
