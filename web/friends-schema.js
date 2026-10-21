(function(root){
const TYPES = {
  sport:{name:'运动',icon:'🏸',main:{key:'item',label:'运动项目',opts:['羽毛球','篮球','足球','乒乓球','网球','排球','跑步','游泳','健身','飞盘','骑行','其他']},
    extra:[{key:'level',label:'我的水平',opts:['新手','一般','熟练','很强']},
           {key:'want',label:'希望对方水平',multi:true,opts:['新手','一般','熟练','很强','都行']},
           {key:'fee',label:'场地费',opts:['AA','轮流请','都行']}]},
  study:{name:'自习',icon:'📚',main:{key:'item',label:'学什么',opts:['期末复习','考研','雅思/托福','考公','编程','其他']},
    extra:[{key:'place',label:'常去地点',opts:['图书馆','教学楼自习室','咖啡馆','都行']},
           {key:'style',label:'自习方式',opts:['各学各的','可以讨论','都行']}]},
  meal:{name:'饭搭子',icon:'🍜',main:{key:'item',label:'吃什么',opts:['食堂','校外小店','探店打卡','都行']},
    extra:[{key:'budget',label:'人均预算',opts:['30以内','50以内','100以内','不限']},
           {key:'taste',label:'口味',multi:true,opts:['能吃辣','不吃辣','清淡','都行']},
           {key:'chat',label:'吃饭时',opts:['边吃边聊','安静吃','都行']}]},
  movie:{name:'电影',icon:'🎬',main:{key:'item',label:'在哪看',opts:['电影院','线上一起看','都行']},
    extra:[{key:'genre',label:'爱看的类型',multi:true,opts:['动作','喜剧','悬疑','爱情','动画','科幻','文艺']},
           {key:'talk',label:'看完想聊聊吗',opts:['想','不用','都行']}]},
  game:{name:'游戏',icon:'🎮',online:true,main:{key:'item',label:'游戏名',text:true,ph:'例如：王者荣耀、原神'},
    extra:[{key:'level',label:'我的水平',opts:['新手','一般','熟练','高手']},
           {key:'mic',label:'开麦',opts:['开麦','不开麦','都行']}]},
  trip:{name:'逛街/旅游',icon:'🛍️',main:{key:'item',label:'去哪',opts:['市内逛吃','周边一日游','远途']},
    extra:[{key:'budget',label:'预算',opts:['省钱为主','适中','不限']},
           {key:'plan',label:'风格',opts:['做好攻略','走到哪算哪','都行']}]},
  show:{name:'演出/展览',icon:'🎤',main:{key:'item',label:'类型',opts:['演唱会','livehouse','音乐节','话剧','展览']},
    extra:[{key:'ticket',label:'抢票',opts:['我来抢','对方抢','一起抢','都行']}]}
};
const COMMON = [
  {key:'time',label:'空闲时间',multi:true,opts:['工作日白天','工作日晚上','周末白天','周末晚上']},
  {key:'campus',label:'所在校区',select:true,opts:['广州南校','广州东校','广州北校','深圳校区','珠海校区']},
  {key:'cross',label:'愿意跨校区吗',opts:['只要本校区','可以跨校区']},
  {key:'gender',label:'对方性别',opts:['男生','女生','不限']},
  {key:'freq',label:'想多久约一次',opts:['一次性','每周','长期固定']}
];
const MAX = 6;


const schema={TYPES,COMMON,MAX};if(typeof module==='object')module.exports=schema;else root.FriendsSchema=schema;
})(globalThis);
