(function(root){
'use strict';
// 深度交友问卷全量 schema（二期）：题干/选项/性格滑块/兴趣细分全部后台可管。
// 结构：steps=6 步标题；cards[step]=卡片数组；special 块（personality/interests/photos/contacts）。
// schools 从 deep-options.json 迁移而来；deep-options kind 由本 schema 派生（兼容旧端点）。
const schools = {"中山大学":["广州南校园","广州北校园","广州东校园","珠海校区","深圳校区"],"华南理工大学":["广州天河五山","广州番禺大学城","广州花都国际"],"暨南大学":["广州天河石牌","广州番禺校区","广州增城广园东","珠海校区","深圳校区"],"华南师范大学":["广州天河石牌","广州番禺大学城","佛山南海校区"],"华南农业大学":["广州天河校区"],"广州中医药大学":["广州番禺大学城","广州白云三元里"],"广州医科大学":["广州番禺校区","广州越秀校区"],"星海音乐学院":["广州番禺大学城","广州天河沙河"],"广州美术学院":["广州番禺大学城","广州海珠昌岗"],"广东药科大学":["广州番禺大学城","中山校区","云浮校区"],"广东工业大学":["广州番禺大学城","广州越秀东风东","广州天河龙洞","广州番禺校区","揭阳校区"],"广州大学":["广州番禺大学城","广州越秀桂花岗"],"广东外语外贸大学":["广州白云校区","广州番禺大学城","广州天河校区"]};

const schema = {
  version: '1.0',
  steps: ['基础背景', '个人特质', '你的兴趣', '自我介绍', '上传照片', '联系方式'],
  schools,
  cards: [
    [ // STEP 1 基础背景
      { label: '基本信息', required: true, items: [
        { key: 'sex', type: 'options', label: '你的性别', required: true, options: ['男', '女'] },
        { key: 'sex_prefer', type: 'tags', label: '期望交友对象性别', hint: '此项与期望校区作为双方筛选条件', options: [{ value: '男', label: '男生' }, { value: '女', label: '女生' }, '不限'] }
      ] },
      { label: '年级与校区', required: true, items: [
        { key: 'grade', type: 'select', label: '你的年级', required: true, placeholder: '选择年级', groups: {
          '本科': ['大一', '大二', '大三', '大四', '大五（医学）'],
          '研究生': ['研0', '研一', '研二', '研三', '博士'] } },
        { key: 'grade_prefer', type: 'tags', label: '期望对方年级（可多选，仅影响评分）', options: ['不限', '大一', '大二', '大三', '大四', '研一', '研二', '研三', '博士'] }
      ] },
      { label: '专业与家乡', items: [
        { key: 'major_category', type: 'major', label: '专业大类' },
        { key: 'major_detail', type: 'text', label: '细分专业', placeholder: '例如：计算机科学与技术', max: 60 },
        { key: 'major_prefer', type: 'tags', label: '期望对方专业（可多选，仅影响评分）', options: ['不限', '人文社科类', '经济管理类', '理学类', '工学类', '医学类', '艺术体育类', '其他'] },
        { key: 'hometown', type: 'select', label: '你的家乡', placeholder: '选择地区', groups: {
          '内地省份': ['广东', '北京', '上海', '浙江', '江苏', '四川', '湖北', '湖南', '福建', '山东', '河南', '安徽', '江西', '广西', '海南', '云南', '贵州', '陕西', '甘肃', '青海', '内蒙古', '新疆', '西藏', '宁夏', '天津', '重庆', '辽宁', '吉林', '黑龙江', '河北', '山西'],
          '港澳台地区': ['香港', '澳门', '台湾'],
          '其他': ['国外'] } }
      ] },
      { label: '学校', required: true, items: [
        { key: 'school', type: 'select', label: '学校', required: true, hint: '目前仅开放中山大学，请选择你所在的校区。', fromSchools: true }
      ] },
      { label: '所在校区', required: true, items: [
        { key: 'own_campus', type: 'campus', label: '选择学校后，请选择你的校区（单选）' }
      ] },
      { label: '期望对方的学校和校区（可多选）', hint: '此项与期望性别作为双方筛选条件；不填视为不限。年级、专业、性格和兴趣仅用于评分，不作为硬限制。', items: [
        { key: 'expect_quick', type: 'tags', label: '选择中山大学，并勾选愿意认识的校区；不填视为不限校区。', options: ['不限', '广州所有校区', '大学城所有校区'] },
        { key: 'expect_schools', type: 'expect-campus', label: '+ 添加中山大学校区偏好' }
      ] },
      { label: '交流方式偏好', items: [
        { key: 'online_offline', type: 'options', label: '交流方式', options: ['线上为主', '线下为主', '都行'] }
      ] }
    ],
    [ // STEP 2 个人特质
      { label: 'MBTI', items: [
        { key: 'mbti', type: 'select', label: 'MBTI', placeholder: '选择MBTI', options: [
          { value: 'INTJ', label: 'INTJ - 建筑师' }, { value: 'INTP', label: 'INTP - 逻辑学家' },
          { value: 'ENTJ', label: 'ENTJ - 指挥官' }, { value: 'ENTP', label: 'ENTP - 辩论家' },
          { value: 'INFJ', label: 'INFJ - 提倡者' }, { value: 'INFP', label: 'INFP - 调解员' },
          { value: 'ENFJ', label: 'ENFJ - 主人公' }, { value: 'ENFP', label: 'ENFP - 竞选者' },
          { value: 'ISTJ', label: 'ISTJ - 检查员' }, { value: 'ISTP', label: 'ISTP - 工匠' },
          { value: 'ESTJ', label: 'ESTJ - 执行官' }, { value: 'ESTP', label: 'ESTP - 企业家' },
          { value: 'ISFJ', label: 'ISFJ - 守卫者' }, { value: 'ISFP', label: 'ISFP - 探险家' },
          { value: 'ESFJ', label: 'ESFJ - 供给者' }, { value: 'ESFP', label: 'ESFP - 表演者' },
          '不确定'] }
      ] },
      { label: '性格窥探', items: [{ key: 'personality', type: 'personality' }] },
      { label: '交友目的', required: true, items: [
        { key: 'friend_goal', type: 'options', label: '交友目的', required: true, options: ['学习搭子', '饭搭子', '运动搭子', '游戏搭子', '聊天搭子', '综合交友'] }
      ] }
    ],
    [ // STEP 3 兴趣
      { label: '选择你的兴趣大类（按顺序来，优先考虑1哦）', items: [{ key: 'interests', type: 'interests' }] }
    ],
    [ // STEP 4 自我介绍
      { label: '关于我', hint: '简单介绍一下自己，让对方更好地了解你', items: [
        { key: 'self_description', type: 'textarea', placeholder: '例如：性格特点、生活习惯、日常作息等' } ] },
      { label: '期望的朋友', items: [
        { key: 'ideal_friend', type: 'textarea', placeholder: '描述你期望交到什么样的朋友...' } ] },
      { label: '特殊要求', items: [
        { key: 'special_request', type: 'textarea', placeholder: '如果有其他想说的，可以写在这里...' } ] }
    ],
    [ // STEP 5 照片
      { label: '个人照片（可选）', hint: '上传照片可以让你的资料更真实可信', items: [
        { key: 'photos', type: 'photos' } ] },
      { label: '关于展示（不填默认全部）', items: [
        { key: 'display_self', type: 'tags', label: '展示板块', options: ['基础背景', '个人特质', '兴趣爱好', '自我介绍', '照片'] } ] }
    ],
    [ // STEP 6 联系方式
      { label: '添加联系方式', required: true, hint: '至少填写一种联系方式', items: [
        { key: 'contact_entries', type: 'contacts' } ] }
    ]
  ],
  // 性格滑块：title=维度名 self=自评题干 left/right=两端文案（left/right 改动不影响存储，自由改）
  personality: [
    { title: '交流倾向', self: '你话多吗？', left: 'Speaker', right: 'Listener' },
    { title: '社交偏好', self: '你爱凑热闹吗？', left: '燥起来！', right: '我想静静' },
    { title: '决策方式', self: '你理性吗？', left: '理性分析', right: '直觉感受' },
    { title: '新事物态度', self: '你的性格', left: '尝试新鲜', right: '安于熟悉' },
    { title: '事后态度', self: '当活动结束……', left: '习惯回味复盘', right: '随它去吧' },
    { title: '生活方式', self: '你会计划吗', left: '事无巨细', right: '随便好啦' }
  ],
  // 兴趣模块：categories=大类（顺序即优先级）；subcategories=大类→细分（细分文案改动自由）；
  // skillLevels/freq 参与匹配计分，改动需 force。
  interests: {
    categories: ['球类运动', '田径类运动', '其他运动', '棋类', '健身健美', '音乐', '乐器', '书法', '绘画', '阅读', '摄影', '电影', '纪录片', '电视剧', '娱乐圈', '舞蹈', '美食(吃）', '烹饪', '手游', '端游', '主机', '桌游', '旅游', '小动物', '美妆时装', 'ACG', '体育赛事', '手工', '博客', '娱乐活动', '其他爱好'],
    subcategories: {
      '球类运动': ['篮球', '足球', '羽毛球', '乒乓球', '网球', '排球', '匹克球', '高尔夫', '棒球'],
      '田径类运动': ['短跑', '长跑', '竞走', '跳高', '跳远', '铅球', '铁饼', '标枪', '马拉松'],
      '其他运动': ['游泳', '瑜伽', '普拉提', '搏击', '攀岩', '滑雪', '滑板', '骑行', '钓鱼', '冲浪', '飞盘'],
      '健身健美': ['减脂', '增肌', '塑形', '运动表现'],
      '棋类': ['围棋', '中国象棋', '国际象棋', '五子棋', '跳棋', '军棋', '将棋'],
      '音乐': ['流行', '摇滚', '古典', '电子', '民谣', '爵士', 'R&B', '说唱', '金属', '古风', '蓝调'],
      '乐器': ['钢琴', '吉他', '小提琴', '古筝', '二胡', '架子鼓', '长笛', '口琴', '葫芦丝', '尤克里里', '贝斯', '萨克斯', '大提琴', '双簧管', '扬琴', '琵琶'],
      '书法': ['楷书', '行书', '草书', '隶书', '篆书', '硬笔书法'],
      '绘画': ['素描', '水彩', '油画', '国画', '漫画', '板绘', '彩铅', '丙烯'],
      '阅读': ['网文', '小说', 'Non-fiction', '散文', '随笔', '古典/经典', '热销/流行', '戏剧', '神话/史诗/传说'],
      '摄影': ['人像', '风光', '鸟', '纪实', '扫街', '微距', '星空', '建筑', '气象'],
      '电影': ['爱情', '喜剧', '动作', '科幻', '悬疑', '恐怖', '纪录', '动画', '文艺', '历史'],
      '纪录片': ['自然', '历史', '科技', '社会', '美食', '人文', '探险'],
      '电视剧': ['国产', '美剧', '日剧', '韩剧', '英剧', '港台剧', '短剧', '长剧', '悬疑/推理', '古装/仙侠', '爱情/偶像', '科幻/奇幻', '喜剧/搞笑', '家庭/伦理', '职场', '历史', '校园/青春'],
      '娱乐圈': ['内娱', '韩娱', '欧美', '追线下', '物料党', '喜八卦'],
      '舞蹈': ['街舞', '拉丁', '芭蕾', '民族舞', '现代舞', '爵士舞', '宅舞', '广场舞'],
      '美食(吃）': ['中餐', '西餐', '日料', '韩餐', '甜品', '小吃', '火锅', '烧烤', '饮品'],
      '烹饪': ['中餐', '西餐', '烘焙', '甜品', '日料', '减脂餐', '家常菜'],
      '手游': ['Moba', 'Fps', '单机', '开放世界', '卡牌', '建筑经营策略', '乙游', '跑酷', '休闲', '体育竞技', '解密', '王者', '吃鸡', '瓦', '洲', '第五人格', '原神', '崩坏', '部落冲突/皇室战争'],
      '端游': ['3A', 'Moba', 'Fps', '沙盒'],
      '主机': ['Steam', '任天堂', 'Xbox', '索尼'],
      '桌游': ['狼人杀', '剧本杀', '三国杀', '大富翁', '阿瓦隆', 'UNO', '卡坦岛'],
      '旅游': ['自然风光', '历史文化', '城市探索', '海岛度假', '自驾', '穷游', '热门打卡'],
      '小动物': ['狗', '猫', '兔', '仓鼠', '鸟', '鱼', '爬宠', '昆虫'],
      '美妆时装': ['美妆', '护肤', '穿搭', '球鞋', '配饰', '发型'],
      'ACG': ['日漫', '国漫', '轻小说', 'Cosplay', '手办', '声优', '二创'],
      '体育赛事': ['世界杯', '斯诺克', 'F1', 'NBA', '欧冠', '温网', '环法', 'UFC', 'WRC', 'MotoGP', '勒芒24时'],
      '手工': ['拼豆', '插花', '黏土', '编织', '木工', '皮具', '滴胶', '折纸'],
      '博客': ['技术博客', '生活博客', '美食博客', '旅游博客', '读书博客', '影评博客'],
      '娱乐活动': ['麻将', '纸牌', '台球', 'KTV', '喝酒', '散步', '咖啡'],
      '其他爱好': ['学习', '咖啡', '植物', '气象', '剪辑', '相声', '脱口秀', '话剧', '音乐会']
    },
    skillLevels: ['完全小白', '云玩家', '入门', '一般般', '精通'],
    freq: ['每日', '每周', '每月', '每学期', '没要求']
  },
  photos: { max: 3, hint: '支持 JPG、PNG 格式' },
  contacts: { methods: ['微信', 'QQ', '小红书', '邮箱', '其他'] }
};

if(typeof module==="object"&&module.exports)module.exports=schema;else root.DeepSchema=schema;
})(typeof window==="object"?window:globalThis);