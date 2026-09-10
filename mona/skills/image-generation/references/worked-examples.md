# Worked prompt examples

These Mona-authored examples illustrate complete prompts, not measured image-generation results. Read one when it resolves a concrete writing gap; an ordinary task does not have to start with a named case. More visual directions are available through [case-index.md](case-index.md). Preserve the user's brief rather than importing an example's colors or imagery wholesale.

## 武汉旅行海报：普通海报也能写具体

**基线判断：** 原始 brief 已经合格地说明了旅行海报用途、黄鹤楼/江桥/高楼的前中后景关系，以及樱花、橙粉紫晚霞和“武汉”书法字这些核心元素；它并非完全没有构图。缺少的是成品形态与画幅、主体比例、标题落点与留白、明确的阅读顺序、具体媒介与表面、颜色角色和统一光线，以及多余文字和拼贴等失败边界；`modern`、`vibrant`、`professional` 等泛词也没有落实为可执行选择。类似的普通旅行海报可直接参考下面的完整 prompt，无需先读取具体案例。

```text
制作一张完整的武汉旅行海报，3:4竖版，城市旅行宣传用途。黄鹤楼、江桥和远景高楼是概念合成的武汉意象，不代表真实同一机位。阅读顺序：上方标题“武汉”→前景黄鹤楼→中景江桥→背景天际线。上方约25%留干净天空；标题在左上天空留白内左对齐，使用醒目的手写书法字，字形完整清晰。黄鹤楼在下方偏右，占约35%画面，是最大焦点；江桥从左下斜向右中延伸，占次要面积；高楼压低、简化为远景。樱花枝只在右上和左下轻轻入画，作为陪衬，不遮挡标题或楼。采用复古丝网印刷城市插画：简化建筑轮廓、平涂色块、轻微套色偏移、可见纸纤维和印刷颗粒，不要照片或3D；各层保留呼吸感，缩小为社媒缩略图时仍能一眼读出标题与黄鹤楼。主色为深靛蓝，辅助色为雾粉、浅紫，晚霞用暖橙，朱红只强调标题；统一右上方斜向柔和夕照，所有景物阴影方向一致。只出现准确汉字“武汉”，不添加副标题、英文、数字、其它地名、logo、随机字或水印；不要地图、路线图、九宫格、拼贴板、拥挤天际线、过多樱花、错误建筑结构或让装饰抢过主视觉。
```

**这些句子补了哪些决策：** 把“有武汉元素”补成了一个可读的成品系统：先锁成品和画幅，再锁标题、前中后景的比例与阅读路径；用统一的丝网印刷媒介、角色分明的色板和单一夕照收束风格；最后锁定可见文字和普通海报常见的拼贴、拥挤、遮挡风险。

## Presentation hero: enterprise AI operations

**Intent:** a wide cover visual with editable title space outside the image.

**Template:** editorial hero with a premium technology surface system.

```text
Create one finished 16:9 editorial hero image for an enterprise presentation about coordinated AI operations. The visual job is to make many autonomous processes feel controlled, observable, and trustworthy.

Subject and moment: a single luminous orchestration core coordinates several distinct work streams represented by ordered translucent paths, checkpoints, and compact physical modules; one path is being rerouted around a visible constraint. No humanoid robots and no floating user-interface panels.

Composition: the orchestration core and active paths occupy the right two-thirds; reserve the left third as calm dark negative space with minimal detail for external slide typography. Layered depth, slightly elevated wide viewpoint, strong focal hierarchy, no symmetrical icon grid.

Visual system: premium technology with physically coherent dark glass, brushed graphite metal, and translucent acrylic. Midnight navy and charcoal base, restrained cyan guidance light, one warm amber alert accent. Soft directional rim light, subtle atmospheric depth, precise reflections.

No text, letters, numbers, logos, labels, captions, watermarks, neon circuit-board cliché, purple gradient fog, or decorative binary code.
```

Tool controls: `aspect_ratio="16:9"`, `image_size="2K"` when supported.

## Presentation concept illustration: organizational change

**Intent:** an explanatory image that feels human and editorial rather than like stock photography.

**Template:** tactile editorial illustration.

```text
Create one finished 4:3 editorial illustration about an organization moving from isolated teams to shared work. The visual job is to communicate that coordination changes the system, not merely the number of meetings.

Subject and moment: three small teams on separate paper-like platforms are actively joining their incomplete pathways into one continuous bridge; the first shared delivery is crossing the newly connected center. Make the connection action and the moving delivery the two meaning-bearing details.

Composition: clear left-to-right progression, three foreground team clusters, one central joining point, destination in the upper-right. Keep generous breathing room and readable silhouettes; avoid an equal-sized card layout.

Visual system: tactile cut-paper editorial illustration, simplified geometric people, warm ivory paper, deep navy and muted coral with small sage accents, broad flat shadows from the upper left, visible paper fibers and subtle risograph grain, calm intelligent tone.

No text, letters, logos, labels, arrows, watermarks, glossy 3D rendering, office-stock-photo composition, or decorative technology icons.
```

## Scientific infographic: battery lifecycle

**Intent:** a self-contained educational graphic with a small amount of exact text.

**Template:** scientific atlas with a circular flow.

```text
Create one finished vertical scientific infographic explaining a lithium-ion battery lifecycle to a general audience.

Structure: a clockwise circular flow with exactly five numbered stages around one central cutaway battery: 1 原料, 2 制造, 3 使用, 4 梯次利用, 5 回收. Each stage has one distinct specimen-style visual and only its number plus exact short label. Use clear arrows between adjacent stages and a small color legend with no prose.

Composition: title area at top, central battery as the largest object, five evenly spaced stages with visibly different materials and processes, legend at bottom. Strong reading order, no crossing connectors, generous margins.

Visual system: modern scientific atlas, precise fine linework, softly shaded cutaway objects, light mineral-paper texture. Warm white background, graphite labels, low-saturation blue-gray base; functional accents of ochre, green, teal, violet, and rust assigned consistently to the five stages. Neutral even illumination.

Visible text, copied exactly: “锂电池的循环旅程”, “原料”, “制造”, “使用”, “梯次利用”, “回收”. No other readable text, letters, logos, signatures, or watermarks. Avoid long paragraphs, repeated generic battery icons, cyberpunk decoration, and ambiguous arrow directions.
```

## Product campaign: bottled tea

**Intent:** premium commerce image with reliable packaging geometry.

**Template:** product studio.

```text
Create one finished 3:4 premium product campaign image for a chilled jasmine tea.

Subject and moment: one clear glass bottle stands upright on pale limestone; cold condensation beads follow the real bottle curvature. A small jasmine branch and two loose petals sit behind the bottle, while a thin ribbon of tea-colored liquid curves once around the base without obscuring the label.

Composition: bottle fills about 65% of frame height, centered slightly left, label fully front-facing and unobstructed, grounded contact shadow, restrained props, clean upper-right breathing room.

Visual system: high-end beverage studio photography, accurate transparent glass and pale amber liquid, matte cream paper label, limestone texture. Soft morning key light from upper left, narrow warm rim light, sage-gray background gradient, natural reflections and crisp condensation.

Preserve the exact package shape and exact supplied label artwork from the reference image. No duplicate bottles, extra fruit, floating petals, altered label text, invented logos, hands, splash explosion, glossy plastic, or watermark.
```

Use the package reference in `reference_images`.

Tool controls: `aspect_ratio="3:4"`, `image_size="2K"` when supported.

## Documentary report image: maintenance work

**Intent:** credible real-world image rather than staged corporate advertising.

**Template:** documentary photography.

```text
Create one finished 3:4 documentary photograph of municipal maintenance work during light rain.

Subject and moment: two road technicians kneel beside an opened storm-drain inspection hatch; one shines a compact work light onto a visibly blocked channel while the other marks the finding on a weatherproof clipboard. Wet gloves, scuffed reflective jackets, muddy water and a few real tools establish the work.

Composition: handheld eye-level viewpoint from several metres away, technicians in the lower-right half, the open drain and reflected street lights lead into the frame, ordinary residential street receding behind them. Slightly imperfect crop and layered foreground rain droplets, but both workers and the fault remain readable.

Visual system: natural documentary photography, available overcast light mixed with the warm work lamp, realistic wet asphalt reflections, modest contrast, natural skin and fabric texture, subtle sensor grain.

No readable text, logos, staged smiles, spotless equipment, cinematic smoke, dramatic advertising light, CGI surfaces, impossible rain, or watermark.
```

## Historical scene: Song-dynasty workshop

**Intent:** historically grounded narrative image.

**Template:** historical editorial with cinematic realism.

```text
Create one finished wide historical editorial scene set in a Northern Song urban print workshop. The visual job is to show movable-type printing as skilled collaborative labor.

Subject and moment: a lead craftsperson checks the alignment of a composed type forme while an assistant inks another forme and a third worker carefully lifts a fresh paper impression. The aligned type, ink pad, paper impression and drying sheets are the evidence-bearing details.

Composition: eye-level medium-wide view across the worktable, lead craftsperson at the visual center, tools and actions arranged in a clear triangular hierarchy, shelves and courtyard architecture as quiet context. Warm foreground activity, cool daylight from the rear courtyard, credible depth and scale.

Visual system: grounded cinematic realism with restrained Northern Song painting-inspired color harmony; timber, ink stone, fibrous paper and work garments show period-appropriate material detail. Earth, soot black, faded mineral green and paper white; soft daylight and warm reflected interior light.

Historically consistent Northern Song clothing structure, workshop tools, furniture and architecture. No Qing queues, later ceremonial costumes, Japanese elements, modern books, electric lights, plastic, fantasy palace décor, readable invented calligraphy, or watermark.
```

## Reference edit: change environment without identity drift

**Intent:** preserve a portrait while changing only its setting and light.

```text
Edit the reference portrait into one finished environmental photograph.

Preserve: the same person's facial identity, age, skin tone, short curly hair, round glasses, olive overshirt, relaxed three-quarter pose, waist-up crop, hand position, and camera perspective.

Change: replace the plain background with a quiet independent bookstore at early evening. Add softly out-of-focus timber shelves and one warm reading lamp behind the subject. Shift the overall light to a natural warm interior key with a faint cool window rim on the hair.

Keep unchanged: face shape and features, expression, body proportions, clothing cut and color, glasses, hands, crop, viewpoint, and shallow depth of field.

Finish: believable 50mm environmental portrait, natural skin texture, coherent shadows and reflections, subtle film grain. No additional people, readable book titles, logo, watermark, beauty retouching, costume changes, or facial drift.
```

Use the original portrait in `reference_images` and keep the original aspect ratio unless the user requests a new crop.
