/** 从单个子句剥离请求语气、动词前缀和载体词，返回核心主题（可能为空）。 */
function stripClause(input: string): string {
  let t = input.trim();
  // 请求语气前缀
  t = t.replace(/^(请|麻烦|劳烦|帮我|帮忙|我想(?:要)?|我要|我希望|给我|为我|需要)\s*/u, "");
  t = t.replace(/^(please\s+)?(help\s+me\s+)?/i, "");
  // 制作类动词前缀
  t = t.replace(/^(生成|制作|做|创建|拍摄|剪辑|剪|录|写|画)\s*/u, "");
  t = t.replace(/^(make|create|generate|produce|shoot|record|write|draw)\s+/i, "");
  // 量词 / 冠词
  t = t.replace(/^(一个|一段|一部|一条|一份|一套|个|段|部|条|份|套)\s*/u, "");
  t = t.replace(/^(a|an|the|one)\s+/i, "");
  // “关于/主题”类前缀
  t = t.replace(/^(关于|有关|围绕|主题是|题目是|主题|题目)\s*/u, "");
  t = t.replace(/^(about|on)\s+/i, "");
  // “video about …”类前缀
  t = t.replace(/^(视频|短片|PPT|演示|幻灯片)\s*(关于)?\s*/u, "");
  t = t.replace(/^(videos?|presentations?|slides?|decks?|pptx?)\s+(about|on)\s+/i, "");
  // 题材动词前缀
  t = t.replace(/^(介绍|讲解|科普|宣传|展示|纪录|记录|汇报|总结)(一下)?\s*/u, "");
  // 结尾载体词
  t = t.replace(/(的)?(视频|短片|片子|影片|动画|小视频|PPT|演示文稿|演示|幻灯片|课件)\s*$/u, "");
  t = t.replace(/\s*(video|short|film|movie|animation|clip|presentation|slides?|deck|pptx?)s?\s*$/i, "");
  return t.trim();
}

/** 从用户输入提取简洁的项目名称：剥离请求语气、动词前缀和"视频/PPT"类
 * 载体词，取核心主题；重名时追加 -2/-3 序号保证唯一。
 * 视频与 PPT 模块共用。 */
export function generateProjectName(
  topic: string,
  existingNames: string[],
  fallback = "未命名项目",
): string {
  // 用户常把核心主题放在“做一个PPT，主题是XXX”的后半句，逐个子句尝试，
  // 取第一个剥离后非空的子句
  let t = "";
  for (const clause of topic.trim().split(/[，。；！？,.;!?\n]/)) {
    t = stripClause(clause);
    if (t) break;
  }
  // 仅保留中英文、数字、空白和短横线，空白折叠为短横线
  t = t
    .replace(/[^\w一-鿿\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24)
    .replace(/^-|-$/g, "");

  const base = t || fallback;
  if (!existingNames.includes(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!existingNames.includes(candidate)) return candidate;
  }
}
