import { msg } from '../../shared/i18n.ts';

/**
 * Long how-tos the agent reads with read_guide when a task calls for one, so ordinary requests do not
 * carry them. Model-facing, so in Chinese; titles are shown in the panel through t().
 *
 * Sources, to check against when the models change:
 * - qwen_image: the system prompts of Qwen-Image 2.1's official prompt rewriters,
 *   huggingface.co/Qwen/Qwen-Image-2.1-PE-T2I and Qwen-Image-2.1-PE-I2I (system_prompt.txt), condensed.
 * - short_drama story / shots: MiniMax's official 3d-animation-short-generator skill (story outline gates,
 *   shot-table-spec.md: continuity handoff, spatial anchors, hook types, per-second directives), adapted to
 *   live action; github.com/MiniMax-AI/MiniMax-H3/tree/main/skills.
 * - short_drama video: MiniMax's h3-prompt-writing guide (base-en.txt), plus what failed on our own runs.
 */
export interface GuideSection {
  id: string;
  title: string;
  text: string;
}

export interface Guide {
  id: string;
  title: string;
  /** When to read it (for the tool description). */
  when: string;
  sections: GuideSection[];
}

const OVERVIEW = `# 短剧手册

适用：短剧、剧情短片、带故事的广告，以及任何要把多个镜头剪成一条的片子。

你在这里是导演，不只是照单执行。每一步先想清楚：观众看到这里会感觉到什么、知道了什么新东西。只把格式填对、把人物画得一致，片子照样会拖沓、人物发僵、镜头单调。这本手册主要讲怎么避免这三件事。

手册里的例子都来自同一个故事（《23:47的灵异来电》：程诺守着死去女友晚星的旧手机，室友王浩劝他；深夜那部早就开不了机的手机打来了电话），只用来说明写法，不要照搬进用户的故事。

## 步骤
1. 故事（story）：用 write_note 写「剧本」，先写故事大纲（梗概、主角、世界规则、8 个节拍、情感锚点），再写分场剧本。
2. 分镜表（shots）：用 write_note 写「分镜表」，一个镜头一段。写完按清单自查，再给用户看，**等用户认可再往下做**。
3. 设定图（design）：角色的全身照和脸部特写、场景图、重要道具图。
4. 关键帧（keyframes）：每个镜头一张首帧图。出完用 review_items 检查，有问题的单独重做。
5. 视频（video）：每个镜头单独生成一段。提交前告诉用户一共几段、大约要多久，**征得同意**。
6. 剪辑（edit）：用 inspect_clips 找台词的位置，用 assemble_video 拼成片。

第 3、4 步的出图提示词照 qwen_image 手册写，动手前用 read_guide 读一遍。

每一步的结果都留在画布上，用户随时可能改。往下做之前，先用 read_board 读剧本和分镜表的最新内容，按用户改过的来。

用户只要其中一部分时（只写剧本、只出关键帧、只把已有的图做成视频），只做那部分，但那部分的规则照样适用。`;

const STORY = `## 1. 故事

### 先定长度
- 按用户要的时长定镜头数：剪完后平均每个镜头 2–4 秒，1 分钟大约 15–20 个镜头。用户没说时长时，做 30–60 秒（8–15 个镜头），并告诉用户。
- 每个镜头都要单独生成视频，要多久按这台服务器的实测速度算，镜头越多越慢。宁可少而精，不要靠堆镜头凑时长。
- 地点越少越好。室内戏的镜头尽量只朝一两个方向拍：每多一个方向就要多出一张场景图，空间关系也越容易乱。

### 故事大纲（写在剧本最前面）
- 一句话梗概：谁、想要什么、被什么挡住、最后怎样。
- 主角：他想要什么（外在的目标），他真正需要什么（内心的东西），他有什么缺点。危机要因为这个缺点而变得更糟。
- 世界规则：故事里不寻常的设定，先把规则定清楚（例：那部手机只在 23:47 响，只能接不能打），后面不能违反。
- 8 个节拍的因果链：每一拍都是上一拍造成的（因为……所以……），而不是「然后……」。每拍写成「发生了什么 → 之后什么变了」（处境、关系，或观众知道的信息）。说不出「变了什么」的节拍，删掉或者和别的合并。
- 情感锚点：开头埋下一个有感情的东西（一句话、一个物件、一个动作），结尾再用回它，结局才有分量。例：开头程诺一遍遍听手机里晚星留下的一句语音，结尾电话里的声音说出了同一句话。

写完大纲，按这几条检查：
- 主角是主动的：是他的选择推动故事，而不是事情一直发生在他身上。
- 危机因为主角的缺点而加重。
- 问题不靠巧合解决。
- 结尾用回了开头的情感锚点。
- 制造阻力的人不是扁平的坏人，他有自己的理由。
- 对话表现的是关系的变化，而不是在解释主题。

### 开头三秒要抓住人
- 第 1–2 个镜头就要给观众一个问题：一件反常的事、一个危险、一个强烈的反差，或者一句抓人的台词。
- 不要用「交代环境 + 人物发呆」开场。可以先放最抓人的那一刻，再倒回去交代原因；也可以从事情已经发生到一半的时候切进去。
- 例：差的开头是一分钟的程诺坐在沙发上发呆、擦手机，到第 20 个镜头手机才亮。好的开头是漆黑的客厅里，那部碎屏、早就开不了机的手机突然亮了，屏幕上是晚星的名字；然后再交代他为什么守着这部手机。

### 结构
- 单集或独立短片：钩子 → 只交代看懂必需的信息 → 冲突一步步加码 → 转折或揭示 → 结尾。
- 连续剧的一集：结尾停在一个新问题上，让观众想看下一集。
- 每场戏都要「转」：这场戏结束时，人物的处境、关系或观众掌握的信息，必须和开始时不一样。
- 同一种情绪或同一个动作，最多连着两个镜头。第三次出现就删掉或合并。例：五个镜头都在「低头擦手机」，观众第二次就懂了。

### 用动作讲情绪，不要用台词说情绪
- 情绪用动作和道具表现：攥紧、躲开视线、把东西推开、手里的动作停住、想说又咽回去。不要让人物说「我好难过」「我很生气」。
- 台词要短、口语化，一句不超过 15 个字左右（生成的一个镜头只有几秒）。一个镜头最多一个人说一句。
- 对话戏不要一人一句机械地轮流：关键台词之后插一个听的人的反应镜头（不说话），台词之间加动作，让话里有没说出口的东西。

### 剧本怎么写
故事大纲之后按场写：场号、地点、时间（日或夜）、出场人物，然后按顺序写发生的动作和台词。动作写看得见的东西（「他把手机攥在胸口，指节发白」），不写心理活动（「他心里很痛苦」）。`;

const SHOTS = `## 2. 分镜表

用 write_note 写「分镜表」，一个镜头一段，照下面的格式写（用户在画布上好读也好改）：

### S03 · 4 秒 · 中景 · 平视 · 过肩（前景是程诺的右肩）
- 作用：王浩第一次正面劝他，冲突开始
- 钩子：铺垫
- 承接：接上一镜程诺低头擦手机、不理他；这一镜结束时王浩转身朝向画面右侧，下一镜从他走向卧室接起
- 场景图：客厅 · 朝卧室门
- 站位：程诺在画面左侧前景，坐在沙发上，只露出右肩；王浩在画面右侧中景，站在茶几旁，面朝左。茶几在画面下方中间，卧室门在画面右边缘。光线：暖黄落地灯在画面左后方，冷蓝月光从右侧的窗户照进来
- 起始画面：王浩双臂抱胸，看着沙发上的程诺，眉头紧皱
- 分秒：0–1 秒 抱胸看着程诺 → 1–2.5 秒 重重呼一口气，松开手臂，搓了搓后脑勺 → 2.5–6.5 秒 说台词 → 6.5–8 秒 用两根手指把烧烤袋往沙发那边推了推，转身朝向画面右侧
- 运镜：缓慢小幅推近
- 台词：王浩（二十出头，嗓音厚实温和）：行，你慢慢看。我把烧烤放桌上了。
- 声音：挂钟滴答，一声重重的呼气，塑料袋在木桌上滑动
- 生成：8 秒（台词前后都有表演）

编号用 S01、S02……。标题里的秒数是剪完以后的长度（2–5 秒）；「分秒」按生成的时长写，从 0 秒一直写到最后一秒，中间不留空档。

### 每个镜头都要给观众新东西
要么是新的信息，要么是表情的变化、新的空间或新的时间。只是换个角度再看一遍同一件事的，不要切新镜头，用运镜代替。

### 钩子：每个镜头标一个
从这些里选一个：铺垫、揭示、反转、悬念、呼应（用回前面埋下的东西）、温情、笑点、追逐、表情、高潮。
- 第一个和最后一个镜头要用强钩子：揭示、反转、悬念、温情或笑点。
- 连着三个镜头里，至少要有一个揭示、反转或呼应。短剧的观众随时会划走。

### 承接：镜头之间要接得上
- 每个镜头的开头，要接上一个镜头的结尾：姿势、道具在哪、视线、情绪、声音。每个镜头的结尾，要给下一个镜头的开头做好准备。
- 从上往下读一遍「承接」，应该是一条连续的链。故意跳开的要写明，比如「硬切：两小时后」。

### 站位：空间要前后一致（剪在一起不跳）
- 每个镜头写明用哪张场景图，也就是机位朝哪个方向（见「设定图」）。
- 每场戏挑 2–3 个固定的东西当地标（门、沙发、窗），写清它们在画面里的位置。同一场戏里地标的位置不变；机位换了导致地标移位时写明原因（「镜头绕到沙发后面，门从画面右边移到左边」）。
- 人物的左右关系固定不变：比如程诺一直在画面左侧、面朝右，王浩一直在右侧、面朝左。每个镜头都写清人物在画面左边、中间还是右边，在前景、中景还是背景，面朝哪边。只写「看向画面外」不够。
- 视线要接得上：上一个镜头 A 看向画面右侧，下一个镜头 B 就看向画面左侧。人物从画面一侧走出去，下一个镜头从另一侧走进来，保持同一个方向。
- 离场的人：上一镜还在、这一镜不在画面里的人，写清他去了哪里（「王浩已经进了卧室，门关着」），免得后面莫名其妙地出现。
- 光线：每场戏定好主光的方向和颜色，每个镜头沿用；要变的时候（开灯、手机屏幕亮起）写明。
- 一个镜头里有动作或台词的人物，最多 3 个。

### 景别要有节奏
- 每场戏的第一个镜头交代空间：用全景或中景，让观众看清谁在哪、朝哪边。
- 情绪越来越强时，景别往近走：中景 → 近景 → 特写。大特写只留给全片最重要的一两个瞬间。
- 不要一整场都是单人近景。如果连着三个镜头景别和运镜都一样，就换一个。

### 对话戏怎么拍
1. 先用一个双人镜头或过肩镜头，交代两个人的位置。
2. 再正反打：过肩或单人近景，轮流给说话的人。
3. 关键台词之后，插一个听的人的反应镜头（不说话，只有表情和小动作）。
4. 情绪最高的那句台词，用更近的景别。

### 机位和运镜
- 机位以平视为主。仰拍让人物显得强势或有压迫感，俯拍让人物显得弱小、孤立。
- 运镜要有理由：
  - 固定：让表演自己说话，或者表现压抑、凝固。
  - 慢推：注意力聚焦，发现了什么，情绪往里收。
  - 拉远：人物被孤立，或者揭示周围的环境。
  - 摇、横移：跟着视线或动作，揭示新的东西。
  - 跟拍：人物在走动。
  - 轻微晃动：紧张、慌乱。
- 同一场戏里运镜要有变化，不要每个镜头都是「固定」或「慢推」。幅度默认小到中等，大幅度、快速的运镜只用在冲击最强的时刻。

### 分秒：把动作排进时间里
- 每一段写看得见的东西：姿势、表情、视线、手里的东西。5 秒里排 2–3 个动作，做不完更多。
- 台词按每秒 4–5 个字估算长度。有台词的镜头，台词前留 1–1.5 秒做一个小动作，说完留 1 秒左右做反应。
- 镜头里不说话的人也要有反应。
- 不要写「一动不动」「保持低头」这种没有动作的描述。如果这个镜头的意思就是静止，就让环境动起来（灯在闪、钟在走）。

### 生成时长
没有台词：生成 5 秒。一句短台词（10 个字以内）且动作简单：5 秒。台词前后有表演，或者台词超过 10 个字：8 秒。剪辑时再裁到标题里的秒数。

### 不要这样设计
- 第一人称视角的画面：生成视频会糊成鬼影。
- 一个镜头里再切镜头：每个镜头单独生成一段，镜头之间靠剪辑切换。
- 要观众读的大段文字。

### 写完先自查，再给用户看
- 第一个和最后一个镜头是强钩子吗？有没有连着三个镜头都没有揭示、反转或呼应？
- 每个镜头的「作用」都不一样吗？有没有连着三个镜头景别和运镜都一样？
- 从上往下读「承接」，是一条连续的链吗？
- 每个镜头都对应一张场景图吗？同一场戏里，地标位置、人物左右关系、光线都前后一致吗？视线接得上吗？离场的人都写清去向了吗？
- 每场对话戏都有交代空间的镜头和反应镜头吗？
- 「分秒」从 0 秒覆盖到最后一秒了吗？每个动作都看得见吗？有没有只写了情绪？
- 同一个情绪有没有超过两个镜头？

有问题先改好，再给用户看：说明一共几个镜头、成片大约多长、视频大约要生成多久，等用户认可或修改后再往下做。`;

const DESIGN = `## 3. 设定图

用 batch_generate_images，每类图写好 group。提示词照 qwen_image 手册写：没有参考图的读 t2i 一节，有参考图的读 i2i 一节。
- 每个角色一张白底正面全身照（group「全身照」），没有参考图，用英文写。写清体型、发型、肤色，每件衣服的颜色、款式和材质；年龄写人生阶段（a young man in his early twenties），不写具体岁数。表情用平静的中性表情，设定图上的表情会带进后面所有镜头。
- 再拿全身照当参考，出一张正脸头肩特写（group「脸部特写」）：指向参考图里的这个人，不要再用文字描述他的长相。
- 每个场景出没有人的场景图（group「场景」），没有参考图，用英文写。把这场戏会用到的地标都放进去，写清它们在画面里的位置（门在沙发左边、窗在沙发后面），以及光源的位置、方向和颜色。场景图就是这场戏空间和光线的基准，后面关键帧的背景都参考它。日景和夜景要分开出。
- 场景图按机位方向出：这场戏的镜头只朝一个方向拍，就出一张；有正反打（两个人面对面说话）的，两个方向各出一张，name 写清方向，比如「客厅 · 朝沙发」「客厅 · 朝书桌」。关键帧的机位只能用场景图里有的方向：模型不会凭文字把镜头转到参考图里没有的方向，硬写只会把房间画乱（凭空多出一张沙发、一扇门）。
- 反复出现的重要道具，出一张白底道具图（group「道具」）。

之后所有提示词里，同一个人物、场景、道具都用同一套叫法。`;

const KEYFRAMES = `## 4. 关键帧

每个镜头一张图：用 batch_generate_images，aspect 写 16:9，group 写「关键帧」，按镜头顺序提交，name 用镜头编号。aspect 一定要传：带参考图却不传的话，画面比例会跟着第一张参考图走（脸部特写是方的，全身照是竖的）。

### 关键帧就是视频的第 0 秒
关键帧画的是动作开始之前的那一刻：视频里要发生的动作，在这张图里还不能发生。照分镜表的「起始画面」画。
- 差：关键帧写「擦手机的动作停住，眼眶发红」，视频写「擦手机的手停住」。动作在第 0 秒就已经完成了，视频里没东西可演，人物只能干站着。
  好：关键帧写「低着头，用袖口一下下擦着手机屏幕」，视频里再让他停手、慢慢抬眼。
- 差：关键帧写「背对镜头，一只手已经搭在门把手上」，视频写「转身走进卧室」。
  好：关键帧写「站在沙发旁，在画面右侧，身体朝向画面左侧的卧室门」，视频里再走过去、开门。
- 表情也要是起始表情：不要一开始就是情绪的顶点（满脸泪水、瞪大眼睛），给视频留出变化的余地。
- 起始姿势写具体、自然，像动作中途的一瞬：重心落在一条腿上、一只手插在口袋里、手里拎着东西、身体微微侧着。不要写「站直」「双手垂在身体两侧」：那正是全身照的姿势，模型会照搬成证件照一样的站姿。
- 视频里要变化的东西（要亮的屏幕、要开的门、要点的灯），关键帧里只写它变化前的样子，不要给它加光效、反光、亮点：这些细节会被画成已经开始变化。
- 给动作留出空间：人物要走动，就在他要去的方向留出空地；要推镜头，起始画面别太满；有人要入画，那一侧要留空。

### 提示词
照 qwen_image 手册 i2i 一节写，写成一段，顺序是：
1. 先说要做什么：「生成一张新的电影画面」，加上景别和机位。
2. 逐张说清参考图的用途：人物图提供长相、发型和衣服，场景图提供房间布局、家具和光线，道具图提供道具的样子。同一个人的两张图要写明「图1是他的脸部特写，图2是他的全身照，是同一个人」，否则会画成两个人。
3. 从背景到人物再到前景走一遍画面，照分镜表的「站位」写：地标在哪里，人物在画面哪一侧、前景还是中景、什么姿势、朝哪边、看向哪里、什么表情。
4. 光线一句，沿用这场戏的光线。
5. 画风一句，全片保持一样。
6. 最后写「画面中只有N个人物，每个人只出现一次」。

其他要点：
- 人物的长相靠参考图保持：写「图1中的程诺」，不要再用文字描述他的脸和发型；衣服和参考图一样时写「穿着图2中的衣服」。
- 背景用这个镜头对应方向的那张场景图，写「背景是图3的客厅」；近景和特写也要带上，否则背景会漂。
- 提示词里不写 16:9、宽银幕这类画面比例，比例只用 aspect 参数传。
- 画面里有手机或电脑屏幕时，写清楚屏幕上显示什么。
- 不要第一人称视角。

### 尾帧（可选）
镜头必须停在一个确定的状态才能接上下一个镜头时（比如门必须关上），可以再出一张尾帧，视频用首帧加尾帧来生成。尾帧和首帧之间的差别，要能在几秒内用一个连续的动作连起来，差太多中间会变形。

### 检查
出完用 review_items 拼图检查一遍：是不是同一个人、有没有多出来的人、背景对不对、左右朝向和分镜表是否一致、画的是不是动作开始前的状态，人和家具、道具接触的地方（坐的椅子、靠的桌子、手里拿的东西）有没有粘在一起或穿过去。有问题的单独重做，再往下做。

重做的关键帧，name 和 group 要跟原来的一样（还是 S04，不要写成「S04 重做」）：视频确认卡靠它认出重做后的版本。`;

const VIDEO = `## 5. 视频

每个镜头单独生成一段：用 batch_generate_videos，首帧用这个镜头的关键帧（需要时加尾帧），name 用镜头编号，时长按分镜表里的「生成」（5 或 8 秒）。提交前告诉用户一共几段、大约多久，等用户同意。确认卡弹出后又重做了某个首帧的，不用重新提交：用户确认时会自动换成重做后的版本。

### 提示词格式
用英文写，台词保留中文原文。严格照下面的结构写，字段名和顺序都不要改：

For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description: [Shot 1] <画风>, <首帧里有什么：人物是谁、在画面哪一侧、什么姿势、朝哪边>. <运镜>. <动作 1>. <动作 2 或台词>. <结果或反应>. One continuous shot with no cuts and no fades; the picture stays fully lit until the last frame. No subtitles or on-screen text appear.

overall_soundscape: <这个镜头里的声音>

non_diegetic_music: N/A

画风那一句全片保持一样，比如 Photorealistic live-action Chinese web short drama, cinematic。

### 动作：首帧 → 开始 → 展开 → 结果
- 先用一句话锚住首帧（人物、位置、姿势），再写接下来发生什么。5 秒里写 2–3 个动作步骤：太多会做不完或者像快进，没有动作就像一张静止的图。
- 只写看得见、听得见的东西。情绪词（sad、angry、softens、exasperated、hopeless）模型画不出来，要换成身体动作：

| 想表达 | 写成 |
|---|---|
| 难过、压抑 | lowers his head, swallows hard, his thumb keeps rubbing the edge of the phone |
| 生气 | sets the beer can down hard on the table, takes a step forward, his voice rising |
| 无奈 | exhales through his nose, rubs the back of his head, eyes dropping to the floor |
| 心软 | his voice drops, he nudges the bag toward the other man and looks away |
| 震惊 | his hand stops in mid-air, lips parting, he slowly lifts his eyes |
| 惊恐 | he jerks back, nearly dropping the phone, holding his breath |
| 犹豫 | reaches out, then pulls his hand back, presses his lips together, glances at the door |
| 强忍眼泪 | blinks fast, jaw tightening, turns his face away from the other man |

- 写具体的身体部位和东西：手、视线、头、肩、脚步、手里的道具。写方向（toward screen left）和幅度（slightly、sharply）。
- 说台词时身体也在动：台词前一个小动作（吸一口气、抬眼、放下东西），说完一个反应。H3 常常先演动作、后说话，台词会落在后半段，所以台词前的动作要短，或者生成 8 秒。
- 镜头里不说话的人，也写一个反应。

### 运镜：类型 + 幅度 + 速度
写成自然的句子，和分镜表一致：
- The camera holds a static shot as he ...
- The camera pushes in with small amplitude at slow speed toward his hands.
- The camera pulls out with small amplitude at slow speed, leaving him alone in the frame.
- The camera pans right at slow speed, following his gaze to the bedroom door.
- The camera trucks left with small amplitude as she walks along the counter.
- The camera tracks him as he crosses the room.
- The camera shakes slightly as he stumbles back.

另外还可以用 Tilt Up/Down、Pedestal Up/Down、Arc Shot。不要用 POV 和 Roll。

### 台词
- 说话的人用固定编号（S1、S2……），全片不变。第一次出现时描述声音：年龄、性别、音色、语速，例如 the chubby young man with a warm, thick voice (S2)。
- 台词写成 <d>[Chinese] 原文</d>，一字不改。语气和动作写在 <d> 外面。
- 画外音写成 says in an off-screen voiceover: <d>[Chinese] ……</d> while his lips remain completely closed. 电话里的声音写明是从手机里传出来的（comes through the phone speaker, slightly tinny）。
- 没有台词的镜头不要提任何语言，写 Nobody speaks in this shot: no dialogue and no voices. 否则模型会自己编台词，还会烧出字幕。
- 画面里有屏幕时写清显示什么，例如 the phone screen shows only an incoming call from "晚星", with no photo。画面里要出现的字，用英文双引号原样写。

### 环境声（overall_soundscape）
写 1–3 句，只写这个镜头里真会发生的声音：一层环境底噪，加上这个镜头里动作发出的声音（脚步、衣服摩擦、放东西、呼吸）。不要把整场戏的声音复制到每个镜头里：一个人站着说话的镜头里，不该有「门咔哒一声、塑料袋沙沙响」。台词不要写在这里。

### 配乐
non_diegetic_music 写 N/A。配乐不在镜头里生成，否则每个镜头的音乐都不一样，剪起来接不上。

### 完整例子
分镜：S03，中景过肩，王浩站在茶几旁（画面右侧）劝程诺，缓慢推近，台词「行，你慢慢看。我把烧烤放桌上了。」

For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description: [Shot 1] Photorealistic live-action Chinese web short drama, cinematic, the chubby young man in the navy T-shirt from <Picture 1> stands by the coffee table on the right side of the frame, arms crossed, facing screen left toward the sofa. The camera pushes in with small amplitude at slow speed. He exhales hard through his nose, uncrosses his arms and rubs the back of his buzz-cut head, eyes dropping to the floor. Then, quieter, the chubby young man with a warm, thick voice (S2) says: <d>[Chinese] 行，你慢慢看。我把烧烤放桌上了。</d> He nudges the bag of skewers toward the sofa with two fingers and turns away to screen right. One continuous shot with no cuts and no fades; the picture stays fully lit until the last frame. No subtitles or on-screen text appear.

overall_soundscape: Low room tone under the steady tick of a wall clock. A heavy exhale, a palm rasping over short hair, and the plastic bag crinkling as it slides across the wooden table.

non_diegetic_music: N/A

同一场戏里一个没有台词的反应镜头：

For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description: [Shot 1] Photorealistic live-action Chinese web short drama, cinematic, a close shot of the thin young man in the gray sweatshirt from <Picture 1>, sitting hunched on the left end of the sofa, head bowed, wiping the cracked phone screen with his sleeve. The camera holds a static shot. His sleeve stops mid-wipe. He swallows, his grip on the phone tightens, and he slowly lifts his reddened eyes toward screen right without raising his head. Nobody speaks in this shot: no dialogue and no voices. One continuous shot with no cuts and no fades; the picture stays fully lit until the last frame. No subtitles or on-screen text appear.

overall_soundscape: Quiet room tone and the faint tick of a wall clock. Soft fabric rubbing on glass, then a single shaky breath.

non_diegetic_music: N/A

### 检查
全部跑完后，用 review_items 检查（每段视频会取开头、中间、结尾三帧）：动作有没有做出来、人物有没有变形或多出来；再用 inspect_clips 看每段哪几秒有台词。人物崩坏、多出人物、动作没做出来的镜头，说明问题后单独重做；问题出在首帧的，先改关键帧。三帧看不出来的（比如动作快不快、自不自然），请用户看一遍。`;

const EDIT = `## 6. 剪辑

1. 先用 inspect_clips 看每段哪几秒有明显的声音（一般就是台词）。
2. 再用 assemble_video 按镜头顺序拼成片，每段用 start / end 裁掉头尾：
   - 台词必须完整保留。台词在后半段，就从后面取（比如 start=1.5），说完再留 0.3 秒左右。剪辑结果提示有声音被裁掉时，改好了重剪。
   - 动作镜头裁掉开头没动的部分，从动作开始前 0.2–0.3 秒切进来。在动作进行中切到下一个镜头，比等动作做完再切更顺。
   - 长度要有快有慢：钩子短而有力；冲突升级时镜头越来越短；反应镜头 1.5–2 秒就够；情绪最重的镜头多留半秒到一秒，让观众看清。不要每段都裁成一样长。
3. 拼完告诉用户成片多长，以及哪几个镜头你最没把握、最值得再改。`;

const QWEN_OVERVIEW = `# Qwen-Image 提示词手册

给 qwen（Qwen-Image 2.1）写出图提示词的规则，来自它官方提示词改写模型的说明。分两种情况：
- 没有参考图（t2i）：用英文写一整段「看图描述」，像在描述一张已经存在的图片。
- 带参考图（i2i）：写成一条明确的指令，说清每张参考图的用途。

两种都要遵守的：
- 不写画面比例和分辨率（16:9、2K、宽银幕），比例只用 aspect 参数传。
- 不写 masterpiece、8K、highly detailed、高清这类空话。
- 只写画面里有的东西。写「no laptop」「不要出现手机」反而可能把它画出来。
- 画面里要出现的文字放在英文直双引号里，一字不差，用它本来的文字（中文就写中文）。没有要读的文字时，不要编招牌和标语。`;

const QWEN_T2I = `## 没有参考图：英文写一整段看图描述

不管用户用什么语言提要求，提示词都用英文写；只有画面里要出现的文字保持原文。用现在时、第三人称、陈述句，像一个观察者在描述眼前这张图：不写 you、create、make sure。

### 步骤
1. 分清用户定了什么、没定什么。用户定了的（要出现的文字、物体、数量、颜色、位置）原样保留；没定的由你来决定。用户只说了几个字，也要写成完整的一段：要求短，说明大部分画面要你来设计，而不是少写。
2. 第一句（20 个词左右）点明画面类型和画风、主体、背景和色调。例：The image is a vertical photorealistic full-body portrait of a young man in his early twenties standing against a plain white background.
3. 动笔之前先排好：画面里有哪些东西，各在什么位置。整段要用 8–14 个位置短语（in the upper-left corner、across the top、on the far right、in the lower third、in the centre、behind、in front of），覆盖四角、四边和中间，不要全挤在中间。大约三分之一的句子用位置短语开头，比如 On the right side of the frame, ……
4. 按顺序走一遍画面：
   - 画面分成几块的（场景、海报、好几样东西）：先写背景和地面，再写上方，然后从左到右写中间，最后写底部和前景。
   - 一个主体占满画面的（人像、特写、单个物体）：先写背景和虚化程度，再写主体的姿势和在画面里的位置，然后是头和脸、身体和每件衣服、手里拿的东西，最后是边缘剩下的东西。
5. 文字：画面里每段要读的字，按阅读顺序写清位置、样子（粗细、颜色、大小）和内容。
6. 光线单独写一句：光源、方向、软硬，以及它留下的阴影和高光。例：The lighting is soft, even studio light from the front, leaving only faint shadows at his feet.
7. 最后一句退后看整体：构图的平衡、色调、画风和气氛。只写这一句，后面不再总结。

### 篇幅
大约 15–20 句，300–500 个英文单词。画面里东西多的写长一点，单个安静的主体可以短一点，但不要只写三五句。

### 写法
- 人物写看得见的外表：体型、姿势、视线方向、表情、发型、肤色，每件衣服的颜色和材质。年龄写人生阶段（a young man in his early twenties、a middle-aged woman），不写具体岁数。脸被挡住或转开了就直说。
- 颜色加修饰词：deep navy、muted olive、pale cream、charcoal、warm terracotta。
- 东西写出材质：brushed metal、matte plastic、coarse linen、weathered wood、frosted glass。
- 一样一样列出来，不要写 several items、various decorations。数量用英文单词写（three、five）。
- 物体写类别，不写品牌（a silver laptop），除非用户指定了品牌。
- 符合物理：阴影背向光源，倒影和前面的东西对得上，相邻物体的比例一致。`;

const QWEN_I2I = `## 带参考图：写成一条明确的指令

generate_image 或 batch_generate_images 传了 reference_ids 时用这种写法。

### 语言和指代
- 用户用中文提要求就用中文写，用英文就用英文写。
- 两张以上参考图时，用「图1」「图2」按 reference_ids 的顺序指代（系统会换成模型认识的标签）。每张图单独说，不要写「图1到图3」这种合起来的说法。只有一张参考图时，直接说「图中」「这张图里」，不用编号。

### 先说做什么，再说每张图的用途
- 开头先说要做的事（改哪里、生成什么），而不是先描述成品。
- 说清每张图的用途：哪张是底图（构图和其他内容要保留下来的那张），哪些只提供素材（人物的长相和衣服、场景、道具），各取什么。用参考图生成一张全新的画面时（比如分镜关键帧、合影），没有底图：人物图提供长相和衣服，场景图提供布局、家具和光线。

### 保留什么、改什么
- 人物的长相靠指向参考图来保持（「图1中的程诺」），不要用文字重新描述他的脸和发型：用文字描述会让模型重新画一张脸，反而不像。衣服和参考图一样时写「穿着图2中的衣服」。
- 要保留的东西点名就行，不要细细描述它的样子：越具体地描述要保留的部分，它越容易被改掉。一句总括的「其他部分与图1保持一致」比逐个描述更稳。只有要改的部分才写具体。
- 要改的地方改到位：改得太轻，看上去就和原图没区别。
- 只做要求的事，不要顺手清理用户没提到的东西。
- 要求用肯定的说法（「保持背景与图1完全一致」），不要写成禁止（「不要改背景」）。

### 写多少
- 只改一处（换颜色、去掉一样东西、改一行字）时要克制，说清改什么就够了。
- 生成新画面（换场景、合影、海报、分镜关键帧）时要主动设计：照 t2i 一节「走一遍画面」的办法，从背景到人物到前景，写清位置、姿势、视线和光线方向。
- 写成一段，不换行。

### 例子：分镜关键帧（两张人物图 + 一张场景图）
生成一张新的电影画面，中景，平视。图1是程诺的脸部特写，图2是程诺的全身照，是同一个人，提供他的长相、发型和衣服；图3是出租屋客厅，提供房间的布局、家具和光线。背景是图3的客厅：旧沙发靠着后墙，卧室门在沙发左边，挂钟在门的右上方。程诺穿着图2中的衣服，坐在画面左侧三分之一处的沙发上，身体微微前倾，低着头，双手在胸前捧着一部碎屏的黑色旧手机，用右手的袖口擦着屏幕，视线落在手机上，神情疲惫。前景是一张矮木茶几，横在画面底部，上面散着几团揉皱的图纸。光线来自画面左后方的一盏暖黄落地灯，在他的左脸和肩膀上留下暖色的边光，冷蓝色的月光从画面右侧的窗户照进来，房间整体昏暗。写实真人短剧的电影剧照，浅景深，轻微胶片颗粒，暖黄和冷蓝对比的色调。画面中只有1个人物，他只出现一次。`;

export const GUIDES: Guide[] = [
  {
    id: 'short_drama',
    title: msg('短剧手册'),
    when: '做短剧、剧情短片、带故事的广告，或任何要把多个镜头剪成一条的片子',
    sections: [
      { id: 'overview', title: msg('总览'), text: OVERVIEW },
      { id: 'story', title: msg('故事'), text: STORY },
      { id: 'shots', title: msg('分镜表'), text: SHOTS },
      { id: 'design', title: msg('设定图'), text: DESIGN },
      { id: 'keyframes', title: msg('关键帧'), text: KEYFRAMES },
      { id: 'video', title: msg('视频'), text: VIDEO },
      { id: 'edit', title: msg('剪辑'), text: EDIT },
    ],
  },
  {
    id: 'qwen_image',
    title: msg('Qwen-Image 提示词手册'),
    when: '用 qwen（Qwen-Image）出图之前，一段对话里读一次就够',
    sections: [
      { id: 'overview', title: msg('总览'), text: QWEN_OVERVIEW },
      { id: 't2i', title: msg('文生图'), text: QWEN_T2I },
      { id: 'i2i', title: msg('带参考图'), text: QWEN_I2I },
    ],
  },
];
