# Stock Vibe 券商读取可行性

状态：在线券商读取尚未验收。用户当前只有东方财富普通交易账户；本文不记录账户号、登录信息、资金或持仓资料。官方接口文档证明接口形状，不证明某个普通账户已获资格、当前机器已配置，或 Mona 已能调用。

## 能力矩阵

| 能力 | 当前状态 | 范围与限制 |
| --- | --- | --- |
| 东方财富普通交易账户在线读取资金、持仓或成交 | `unavailable/unverified` | 没有 EMT/QMT 量化资格或本地交易终端验收，也没有真实账户只读连接结果。普通交易账户本身不能当作可连接能力。 |
| 成交 CSV 文件复盘 | `contract_verified`（合成样本） | 固定合成成交样本已验证原生解析与 Shadow 合同，并新增按原生东财声明表头的 CSV 专项；不是东方财富真实导出文件，也不是用户账户或收益证据。东财 Excel 文件仍待单独验证。见 [Shadow baseline](stock-vibe-shadow-baseline.md)。 |
| EMT / 东财量化终端读取 | `requires_credentials_and_environment` | 官方文档介绍本地 Windows 量化终端与账户数据对象；Mona 的 EMT 连接器尚未实现，账户资格、安装和只读调用均未实测。 |
| QMT / XtQuant 读取 | `requires_credentials_and_environment` | 官方说明 XtQuant 需运行 MiniQMT，并列出 64 位 Python 3.6–3.12。当前受控 Vibe 环境为 Python 3.13，不能假定可直接安装或复用 SDK；Mona 连接器尚未实现。 |
| Hosted 在线券商写操作 | `unavailable` | 当前 hosted 边界隐藏或拒绝在线券商写工具；不能下单、撤单或改变账户状态。 |

## 接口事实与边界

东方财富官方指引描述的是安装在本地 Windows 环境的量化终端，面向其量化工作流。[东财量化终端快速开始](https://emt.18.cn/api/quant-help/guide/guide.html)；其 Python 数据结构页列出 `Account` 的资金、持仓与账户状态接口。[Account 对象说明](https://emt.18.cn/api/quant-help/python/python_object_trade.html) 这说明文档提供了这些接口定义，不构成普通交易账号具有量化接口资格或本机能够成功读取的证据。

XtQuant 官方快速开始写明运行前需启动 MiniQMT，并列出其 64 位 Python 3.6–3.12 库。[XtQuant 快速开始](https://dict.thinktrader.net/nativeApi/start_now.html) Mona 当前受控运行环境使用 Python 3.13，见 [运行包验证](stock-vibe-runtime-verification.md)。版本范围和 MiniQMT 依赖都未满足实测前提，不能把在线读取标为可用。

XtQuant 的 `query_stock_trades` 查询的是当日成交，返回成交列表或 `None`；官方说明 `None` 可能表示请求失败，也可能表示当日无成交。[XtQuant 成交查询](https://knowledge.thinktrader.net/docs/xtquant/xttrader.html) 因此调用方必须有独立错误/连接状态，不能仅凭 `None` 把“空成交”显示为成功。历史导出或查询接口还需对具体账户权限、时间范围与返回完整性逐项验收；接口名称或文档存在不等同于已接入。

## 可继续使用的路径

没有券商量化资格不会阻断公开行情研究、原生策略验证或本地成交文件复盘。当前文件复盘的 `contract_verified` 只针对合成合同样本；真实券商导出格式仍需脱敏样本做单独映射验收。在线读取只有在用户选择接入、资格与本地环境确认后，才进入受控的资金、持仓、当日成交和历史数据只读测试；任何测试都不得执行真实订单。

## 原生东财文件专项（2026-10-17）

上游解析器声明的列名为 `成交日期,成交时间,股票代码,股票名称,买卖标志,成交数量,成交均价,成交金额,佣金,印花税`。当前检测器按股票代码及买卖标志等字段识别，方向支持 B/S；已识别费用仅相加佣金和印花税，不读取过户费或其他手续费别名。因此不能把解析后的盈亏声称为任意东财导出文件的完整净收益。

CSV loader 依次尝试 UTF-8-SIG、UTF-8、UTF-16、GBK、GB2312；XLS/XLSX 走 pandas.read_excel。上述是源码支持范围，专项实跑仅覆盖合成 CSV，未测试东财 Excel、所有编码或用户导出版本。

新增 `tests/fixtures/stock_vibe/shadow/eastmoney-synthetic.csv` 按该声明制作两笔合成记录，经 fresh 补丁 1–25 的真实 native operation 调用原生 TradeJournalTool，识别为 eastmoney、600519.SH、一组往返，计入佣金和印花税后的样本盈亏 9。Mona 路由定向测试 1 passed，上游既有 header/空代码测试 2 passed；使用 verify9 隔离 Python。没有读取账户资料、连接券商或修改解析算法，真实导出兼容仍未验收。
