# Dashi 12 个主题的设计规则

实际导入按每个文字对象的来源 CSS 选择系统字体：中文无衬线用 Microsoft YaHei，西文无衬线用 Arial，等宽用 Consolas，中文衬线用 SimSun，西文衬线用 Georgia。下列各主题中的字体映射是 profile 的建议值；页面中的局部字体以实际来源和 Office 预览为准。不随安装包加入字体文件。

来源为 Dashi 0.4.11 的生成 profile；文件 `webui/office-editor/mona/presets/dashi-profiles.json`，SHA-256 前缀 `52d0b9eea53fdcee`。以下保留 profile 中的 CSS 字符串与变量写法作为来源证据，不把 12 套规则归并成当前的两类配色。

这里记录的是主题级规则，不是固定版式。所有 pad/gap、字号、圆角等数值沿用来源 CSS px；主题没有固定列数，构图以选中页面的结构为准。主题规则只给出图表网格、标签、色序、柱角和线宽，没有图表数据模型。

原生自由构图可直接参考文字层级、实色填充、线条、间距、形状、圆角和图表色序；这些内容可以用可编辑文字、形状与图表重新组织。`linear-gradient`、`radial-gradient`、`rgba` 透明表面、`backdropFilter`、模糊/多层阴影、媒体渐变遮罩/滤镜和主题装饰效果是 CSS 表现，不能据此声称 PowerPoint 原生对象可完全复现。需要近似时使用可编辑原生对象并检查 Office 实际预览；素材保持独立媒体，不把页面压成整页截图。图表色序本身也不证明模板内图表含可编辑数据表。

profile 将 theme03、theme05 标为含独立 CSS 证据；theme06、08、09、10、11 有缺失源组件记录。其余规则来自生成 profile 和 profile 标记的组件来源。所有主题的全局列数均未声明；缺失组件中的交互或装饰细节不在此推测。

## theme01 — 轻拟态风

- **适用**：产品介绍、企业汇报、方案说明、轻量级发布。
- **色彩**：背景 `radial-gradient(40% 52% at 16% 20%, rgba(120,150,255,.22), transparent 70%), radial-gradient(34% 44% at 84% 14%, rgba(255,150,195,.18), transparent 72%), radial-gradient(42% 52% at 80% 84%, rgba(110,212,172,.20), transparent 72%), radial-gradient(36% 46% at 22% 88%, rgba(245,202,128,.16), transparent 72%), linear-gradient(135deg, #eef0f5, #e6e7ee)`；表面 `rgba(255,255,255,.5)`；文字 `#2b2b30`、次级 `#56565c`；强调 `#e8503a` / `#5b8def`；线 `rgba(43,43,48,.14)`。来源色标另有 `#9a9ba4`、`#46b083`、`#e0a23a`、`#7a5ae0`。图表网格同线色，标签 `#56565c`，序列 `#5b8def #46b083 #e0a23a #e8503a #7a5ae0`，柱角 9、线宽 6。
- **字体**：display/body 均为 `"Noto Sans SC","PingFang SC","Microsoft YaHei",system-ui,sans-serif`；等宽 `'Space Mono',monospace`。层级 kicker/title/subtitle/body/label/caption/metric = `24/78/42/30/24/24/128`；Mona 映射 display/body 为 Microsoft YaHei、等宽为 Consolas，需检查实际字形。
- **空间与样式**：pad/gap `108/40`；圆角 24；卡片内边距 30、边框 1px solid、`backdropFilter: blur(28px) saturate(140%)`；形状线宽 3、面板圆角 24、边框 1。阴影 `0 1px 0 rgba(255,255,255,.75) inset,0 24px 60px rgba(70,72,100,.13)`；媒体圆角 20、渐变遮罩 `linear-gradient(180deg,transparent 62%,rgba(43,43,48,.18))`、边框 `1px solid rgba(255,255,255,.7)`。
- **装饰与表达**：来源装饰 `theme01-bokeh`。玻璃半透明、散景渐层、模糊和媒体遮罩是 CSS 效果；原生可沿用浅灰底、红蓝强调、细边线与较宽留白自由排布。

## theme02 — 炫光紫绿风

- **适用**：科技发布会、AI/自动驾驶/机器人主题、增长故事、创新项目展示。
- **色彩**：背景 `#07090b`、表面 `#0a1d13`、文字 `#eef3f1`、次级 `rgba(238,243,241,0.58)`；强调 `#2fe07f` / `#b9f24a`；线 `rgba(255,255,255,.09)`。另有冷色 `#4ea2ff`、弱文字 `rgba(238,243,241,0.34)`。图表序列 `#2fe07f #b9f24a #2fe0c4 #4ea2ff #9b7dff #ff6fae #ffc24a`，柱角 18、线宽 7。
- **字体**：display `'Space Grotesk','Noto Sans SC',-apple-system,sans-serif`；body `'Noto Sans SC','Space Grotesk',-apple-system,sans-serif`；等宽 `'Space Mono',ui-monospace,'SFMono-Regular',monospace`。层级 `24/58/40/28/24/24/112`；Mona 映射 Microsoft YaHei / Microsoft YaHei / Consolas。
- **空间与样式**：pad/gap `108/32`；圆角 24；卡片 `neon-ticket`、内边距 30、边框 1px solid；阴影 `inset 0 1px 0 rgba(255,255,255,.06),inset 0 0 42px -16px rgba(47,224,127,.2),0 26px 60px -40px rgba(0,0,0,.9)`。媒体圆角 18、遮罩 `linear-gradient(to top,rgba(4,6,8,.52),transparent 46%)`、边框 `1px solid rgba(47,224,127,.3)`；形状线宽 2、面板圆角 24。
- **装饰与表达**：来源装饰 `theme02-grid`。recipe 使用 orbit、split、comparison、process、matrix、metrics、timeline、chart 等 frame；hero 为 open/orbit 且 display 72，editorial 用 rail/pull quote，split 用 ledger，comparison 用 comparison 列表，metric-spotlight 用 band，chart-led 用 plot。原生可把这些信息关系转成可编辑网格、分栏、流程、对比、指标带与图表；霓虹发光、多层阴影和媒体渐变遮罩仍是 CSS 效果。

## theme03 — 深浅代码风

- **适用**：技术方案、开发者大会、系统架构、AI 工程实践。
- **色彩**：背景 `var(--rd-bg,#161513)`；表面 `var(--rd-panel,#f3f2ee)`；文字 `var(--rd-ink,#f3f2ee)`、次级 `var(--rd-ink-2,#b8b6b0)`；强调 `var(--rd-blue,#6e85ff)` / `var(--rd-lime,#c2f53d)`；线 `var(--rd-line,rgba(243,242,238,.22))`。来源 token 还列 `bg #d6d6d3`、`ink #161513`、`ink2 #5c5b57`、`ink3 #908f8a`、`line2 rgba(22,21,19,0.10)`、`blue #2742ec`、`blueInk #f3f5ff`、`panel #1a1916`、`fog rgba(22,21,19,0.07)`。图表 grid `var(--rd-line-2,rgba(243,242,238,.10))`、label `var(--rd-ink-2,#b8b6b0)`；series `var(--rd-blue,#6e85ff) var(--rd-lime,#c2f53d) #2b2a27 #56544f #84827c #a9a7a1 #c4c2bc`，柱角 0、线宽 6。
- **字体**：display/body `"Archivo","Noto Sans SC",system-ui,sans-serif`；等宽 `"Space Mono",ui-monospace,monospace`。层级 `24/62/34/27/24/24/104`；Mona 映射 Microsoft YaHei / Microsoft YaHei / Consolas。
- **空间与样式**：pad/gap `120/40`；圆角 0、阴影 none、装饰 none；卡片 padding 28、border 1px solid；媒体无圆角/滤镜/遮罩，边框 `1px solid var(--rd-line,rgba(243,242,238,.22))`；形状线宽 2、面板圆角 0、边框 1。
- **装饰与表达**：frame 规则按 hero masthead 116、editorial rail 70、split rule 64、comparison axis 58、process path 56、matrix grid 54、metric band 56、timeline spine 54、chart plot 52 区分；列表可用 rail/ledger/comparison/process/timeline，quote 有 pull/matrix，指标可用 band，chart-led 用 plot。profile 保留 `--rd-*` CSS 变量和双组 source tokens；原生可做硬边、规则线、深浅色实色对象及对应信息关系，不把变量模式当作已落地的自动换肤。

## theme04 — 玻璃糖果风

- **适用**：年轻化品牌、消费产品、创意提案、社媒感内容。
- **色彩**：背景 `#000000`；表面 `linear-gradient(180deg,#1c1c1c,#111111)`；文字 `#ffffff`、次级 `#9a9a9a`；强调 `#27E021` / `#FFC700`；线 `rgba(255,255,255,.08)`。来源色板另有 `#FF9FE2`、`#15A7F0`，表面 token `#101010`、`#161616`。图表序列 `#27E021 #FFC700 #FF9FE2 #15A7F0 #FF9FE2 #15A7F0`，柱角 999、线宽 4。
- **字体**：display/body `"Noto Sans SC",-apple-system,"PingFang SC","Microsoft YaHei",sans-serif`；等宽 `"Space Mono",monospace`。层级 `24/54/34/22/20/20/104`；Mona 映射 Microsoft YaHei / Microsoft YaHei / Consolas。
- **空间与样式**：pad/gap `100/40`；圆角 22；阴影 `0 24px 60px rgba(0,0,0,.5)`；卡片 padding 34、border 1px solid；媒体圆角 18、遮罩 `linear-gradient(180deg,transparent 56%,rgba(0,0,0,.48))`、边框 `1.5px solid rgba(255,255,255,.08)`；形状线宽 4、面板圆角 22、边框 1。
- **装饰与表达**：来源装饰 `theme04-sparks`，profile source token 标记 `xhs-base`。保留黑底和彩色强调关系；表面渐变、阴影和媒体遮罩是 CSS 表现，不能当作原生玻璃材质。

## theme05 — 色谱图表风

- **适用**：数据报告、市场分析、KPI 复盘、行业研究。
- **色彩**：背景 `var(--pulse-paper,#e9e4d6)`；表面 `var(--pulse-paper-2,#e1dccd)`；文字 `var(--pulse-ink,#14130f)`、次级 `var(--pulse-mute,#8a8576)`；强调 `var(--pulse-red,#d8402e)` / `var(--pulse-blue,#2c44a0)`；线 `var(--pulse-hair,#c4bfae)`。source tokens 另含 `ink2 #3d3a32`、`dark #1a1814`、`dark2 #2a2620`、`onDark #efe9da`、`onDarkMuted #9a9384`。图表序列 `#d8402e #e2742c #efbe2e #3c9a52 #4da0c6 #2c44a0 #7a3c90`，柱角 0、线宽 3。
- **字体**：display/body `"Arimo","Helvetica Neue",Helvetica,"Noto Sans SC","PingFang SC","Hiragino Sans GB","Microsoft YaHei",Arial,sans-serif`；等宽 `ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace`。层级 `19/78/36/27/19/22/124`；Mona 映射 Microsoft YaHei / Microsoft YaHei / Consolas。
- **空间与样式**：pad/gap `72/28`；圆角 0、阴影 none；frame `theme05-pulse`，上/下界 `88/60`；卡片 mode `rules`、padding 28、border 1px solid；媒体无圆角/滤镜/遮罩，边框 `1px solid var(--pulse-hair,#c4bfae)`；形状线宽 3、面板圆角 0、边框 1。
- **文字与表达**：kicker weight 700、letter spacing `.18em`；title weight 800、`-.01em` tracking、line-height `.98`；subtitle weight 600、line-height `1.3`；body weight 500、line-height `1.45`。来源装饰 `theme05-spectrum`；谱系色序和硬边规则适合图表、KPI 与对照。字距/字重/线高可映射到原生文字属性，CSS frame 的实现细节仍需实看。

## theme06 — 深色图谱风

- **适用**：高密度数据展示、战略分析、科技/金融/产业报告。
- **色彩**：背景 `var(--kx-ink,#0c0c0c)`；表面 `var(--kx-ink-2,#141414)`；文字 `var(--kx-cream,#f0efe6)`、次级 `var(--kx-mute-2,#9a9a92)`；强调 `var(--kx-accent,#c8f135)` / `var(--kx-mute,#c8c8c0)`；线 `var(--kx-line,rgba(255,255,255,.10))`。profile token 为 `kx-slide`、`kx-dark`、`kx-light`；profile 没有给出独立 light 模式的色值。图表序列 `var(--kx-accent,#c8f135) var(--kx-cream,#f0efe6) var(--kx-mute,#c8c8c0)`，柱角 0、线宽 5。
- **字体**：display/body `'Archivo','Noto Sans SC',system-ui,sans-serif`；等宽 `'Space Mono','Noto Sans SC',monospace`。层级 `24/72/42/27/24/24/92`；Mona 映射 Microsoft YaHei / Microsoft YaHei / Consolas。
- **空间与样式**：pad/gap `96/24`；圆角 0、阴影 none；卡片 padding 28、border 1px solid；媒体无圆角/滤镜/遮罩，边框 `1px solid var(--kx-line,rgba(255,255,255,.10))`；形状线宽 2、面板圆角 0、边框 1。
- **装饰与表达**：来源装饰 `theme06-grid`。原生可用深色底、荧光绿强调和稀疏色序组织高密度关系；网格装饰名称不说明其线间距或完整 CSS 行为，不据此臆造细节。

## theme07 — 冷白调研风

- **适用**：调研报告、白皮书、竞品分析、学术/政策型表达。
- **色彩**：背景 `#FAFAF6`、表面 `#FFFFFF`、文字 `#0E110B`、次级 `#83877C`；强调 `#86D62B` / `#AEEA46`；线 `rgba(14,17,11,0.10)`。辅助 token：`#5FA01A`、`#E9FBC6`、`#3D413A`、`#B7BBB0`、`rgba(14,17,11,0.16)`，正/负/警示 `#34B24A` / `#E8443B` / `#EFA63A`。图表序列 `#86D62B #0E110B #9AA08F #EFA63A #B7BBB0`，柱角 10、线宽 5。
- **字体**：display `'Space Grotesk','Noto Sans SC',system-ui,sans-serif`；body `'Noto Sans SC','Space Grotesk',system-ui,sans-serif`；monospace `'Space Grotesk','Noto Sans SC',system-ui,sans-serif`。层级 `22/72/40/28/20/22/112`；Mona 映射 display/body/等宽均为 Microsoft YaHei。
- **空间与样式**：pad/gap `96/24`；圆角 20；阴影 `0 18px 52px rgba(14,17,11,.08)`；卡片 padding 30、border 1.5px solid；媒体圆角 26、遮罩 `linear-gradient(180deg,transparent 66%,rgba(14,17,11,.24))`、边框 `1.5px solid rgba(14,17,11,0.10)`；形状线宽 3、面板圆角 20、边框 1.5。
- **装饰与表达**：来源装饰 `theme07-lens`。报告表达可用绿强调配中性色序；柔和阴影与媒体暗化遮罩属 CSS 表现，正负/警示色要按语义保留。

## theme08 — 黑金实验风

- **适用**：高端发布、品牌提案、实验性概念、奢华科技叙事。
- **色彩**：背景 `#ECEF35`；表面 `#FBFAF4`；文字 `#16150F`、次级 `rgba(22,21,15,.62)`；强调 `#FF3D97` / `#8DBEEC`；线 `#16150F`。原始 token 字符串：`--acl-yellow:#ECEF35; --acl-lilac:#E7E6EE; --acl-ink:#16150F; --acl-pink:#FF3D97; --acl-red:#E83B22; --acl-blue:#8DBEEC; --acl-paper:#FBFAF4; --acl-font-cn:"Noto Sans SC",-apple-system,sans-serif; --acl-font-num:"Anton","Noto Sans SC",sans-serif; --acl-font-mono:"Noto Sans SC",-apple-system,sans-serif; --acl-font-hand:"Noto Sans SC",-apple-system,sans-serif;`。图表序列 `#16150F #FF3D97 #8DBEEC #E83B22 #E7E6EE`，柱角 0、线宽 4。
- **字体**：display `'Anton','Noto Sans SC',sans-serif`；body `'Noto Sans SC',-apple-system,sans-serif`；等宽同 body stack。层级 `20/72/40/27/19/21/120`；Mona 映射 display/body/等宽均为 Microsoft YaHei。
- **空间与样式**：pad/gap `100/24`；圆角 0；阴影 `6px 8px 0 rgba(22,21,15,.18)`；卡片 padding 28、border 3px solid；媒体无圆角/滤镜/遮罩，边框 `8px solid #FBFAF4`；形状线宽 5、面板圆角 0、边框 3。
- **装饰与表达**：来源装饰 `theme08-doodle`。酸黄底、黑字和粉/蓝/红强调形成实验感；硬边、粗框和不对称形状适合原生对象重组，doodle 本身只登记为主题装饰，profile 未给出可直接复用的完整构造。

## theme09 — 深蓝杂志风

- **适用**：品牌故事、人物访谈、企业形象册、深度专题。
- **色彩**：背景 `#050b22`；表面 `linear-gradient(150deg,rgba(255,255,255,.14),rgba(255,255,255,.05))`；文字 `#ffffff`、次级 `rgba(255,255,255,.66)`；强调 `#46e3c6` / `#4a86ff`；线 `rgba(255,255,255,.22)`。辅助色 `#1d49d6`、`#2f6bff`、`#9f7bff`、`#ffb27a`，卡片色 `#0a1230`。图表序列 `#4a86ff #46e3c6 #9f7bff #ffb27a`，柱角 16、线宽 5。
- **字体**：display `'Archivo','Noto Sans SC',sans-serif`；body `'Noto Sans SC','Archivo',sans-serif`；等宽 `'Space Mono',monospace`；script token `'Caveat',cursive`。层级 `26/88/40/30/24/26/132`；Mona 映射 Microsoft YaHei / Microsoft YaHei / Consolas。
- **空间与样式**：pad/gap `110/28`；圆角 26；阴影 `0 24px 60px rgba(3,8,30,.4),inset 0 1px 0 rgba(255,255,255,.25)`；卡片 padding 30、border 1px solid、`backdropFilter: blur(14px)`；媒体圆角 20、遮罩 `linear-gradient(180deg,transparent 58%,rgba(3,8,30,.42))`、边框 `1px solid rgba(255,255,255,.22)`；形状线宽 3、面板圆角 26、边框 1。
- **装饰与表达**：来源装饰 `theme09-orbs`。深蓝留白与杂志型大标题/引用可转成原生文字和色块；玻璃渐变、模糊、光球和图片压暗遮罩不等于原生效果。

## theme10 — 金色指数风

- **适用**：金融数据、投资报告、商业指数、年度榜单。
- **色彩**：主背景 `linear-gradient(158deg,#0a0d11 0%,#141f2a 26%,#33434e 52%,#857f76 78%,#cdb6a0 100%)`；表面 `rgba(255,255,255,.045)`；文字 `#f4f4f2`、次级 `rgba(244,244,242,.72)`；强调 `#5479e8` / `#8fa8e6`；线 `rgba(242,243,246,.13)`。profile 还保留多种背景分支：midnight `radial-gradient(120% 85% at 72% 8%,#1c2533 0%,#0d1016 52%,#07080b 100%)`；graphite `linear-gradient(165deg,#191b1f 0%,#3b3f45 48%,#9a9b9a 82%,#cdcecb 100%)`；dawn `linear-gradient(160deg,#161320 0%,#473846 38%,#9c6f5e 72%,#dcb595 100%)`；paper `#f1f0ec`；vapor `linear-gradient(180deg,#0a0e14 0%,#1c2531 32%,#3a4450 58%,#8a8c90 82%,#cdccc8 100%)`。各分支 foreground/sub/foot 颜色也不同，不能合并成单一固定色板。图表序列 `#5479e8 #8fa8e6 #c8a77b #8e9a91 #7a6c91 #b46f5c`，柱角 8、线宽 5。
- **字体**：display/body `'IBM Plex Sans','Noto Sans SC',sans-serif`；等宽 `'IBM Plex Mono',monospace`。层级 `26/68/40/30/24/24/116`；Mona 映射 Microsoft YaHei / Microsoft YaHei / Consolas。
- **空间与样式**：pad/gap `120/28`；圆角 18；阴影 `inset 0 0 0 1px rgba(242,243,246,.13)`；来源装饰 `theme10-grain`；卡片 padding 30、border 1px solid；媒体圆角 18、无滤镜/遮罩、边框 `1px solid rgba(242,243,246,.13)`；形状线宽 2、面板圆角 18、边框 1。
- **装饰与表达**：多种背景分支、蓝色强调和金/石色序用于金融指数故事；渐变与 grain 是 CSS 来源效果，不折叠成只有深色或浅色两种方向。

## theme11 — 高能增长风

- **适用**：增长复盘、商业计划、融资路演、市场扩张方案。
- **色彩**：背景 `#0B0908`；表面 `rgba(255,244,236,0.026)`；文字 `#F4EEE6`、次级 `rgba(244,238,230,0.60)`；强调 `#FF6E2E` / `#FFC07A`；线 `rgba(244,238,230,0.12)`。额外 token 含 `#E22A0C`、弱文字 `rgba(244,238,230,0.32)` / `rgba(244,238,230,0.16)`、发丝线 `rgba(244,238,230,0.22)`；ember 源字符串 `linear-gradient(110deg, #FFC07A 0%, #FF6E2E 46%, #E22A0C 100%)`，glow/grain/edge token 值为 `0.92/0.5/0.56`。图表序列 `#FFC07A #FF6E2E #E22A0C`，柱角 2、线宽 5。
- **字体**：display `'Space Grotesk','Noto Sans SC',sans-serif`；body `'Noto Sans SC',sans-serif`；等宽 `'Space Grotesk','Noto Sans SC',sans-serif`。层级 `24/68/40/27/24/24/116`；Mona 映射 display/body/等宽均为 Microsoft YaHei。
- **空间与样式**：pad/gap `128/26`；圆角 4、阴影 none；来源装饰 `theme11-ignis`；卡片 padding 30、border 1px solid；媒体圆角 4、无滤镜/遮罩、边框 `1px solid rgba(244,238,230,0.12)`；形状线宽 2、面板圆角 4、边框 1。
- **装饰与表达**：暖色 ember 渐变、暗底和橙色层级适合增长曲线与阶段强调；渐变、glow、grain、edge 是 profile 的 CSS token，不是现成原生发光或纹理支持。

## theme12 — 声波霓虹风

- **适用**：音乐娱乐、潮流活动、直播内容、年轻化发布。
- **色彩**：背景 `#f5e1e3`、表面 `#ffffff`、文字 `#1b1518`、次级 `#7d7176`；强调 `#f15a29` / `#3bb6ec`；线 `rgba(27,21,24,.16)`。来源色标另含 `#1c1416 #5a138e #d61fb5 #f3b8ec #143049 #1f6b2a #baf04f #fdddc6 #7a3a18 #fbb24d #c44ee0 #74d2f0 #bcee54`，深色线 `rgba(27,21,24,.30)`、浅底线 `rgba(245,225,227,.16)` / `rgba(245,225,227,.32)`。图表序列 `#f15a29 #3bb6ec #baf04f #c44ee0 #1f6b2a`，柱角 9、线宽 6。
- **字体**：display/body `'Noto Sans SC', system-ui, sans-serif`；等宽 `'Space Mono', ui-monospace, monospace`。层级 `24/74/33/25/24/24/124`；Mona 映射 Microsoft YaHei / Microsoft YaHei / Consolas。
- **空间与样式**：pad/gap `96/24`；圆角 30、阴影 none；来源装饰 `theme12-shapes`；卡片 padding 30、border 1px solid；媒体圆角 18、无滤镜/遮罩、边框 `1px solid rgba(27,21,24,.16)`；形状线宽 4、面板圆角 30、边框 1。
- **装饰与表达**：profile token 提供浅腮红/白纸底、多色高亮与 shape 装饰；适合活动信息和鲜明分组。颜色和几何形状可原生重组，profile 未声明声波动画或额外 CSS 动效。
