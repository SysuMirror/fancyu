'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {aggregate}=require('../survey-stats');
const store=require('../survey-schema');

test('weekly aggregation counts radio/multi/scale and answered-only questions',()=>{
 const schema=store.current('weekly');
 const rows=[
  {answers:{'1':'男','2':['男','女'],'17a':4,'49':'喜欢运动'}},
  {answers:{'1':'男','2':['男'],'17a':7}},
  {answers:{'1':'女','17a':4}},
 ];
 const qs=aggregate('weekly',schema,rows);
 const q1=qs.find(q=>q.id==='1');
 assert.equal(q1.counts['男'],2);assert.equal(q1.counts['女'],1);assert.equal(q1.answered,3);
 const q2=qs.find(q=>q.id==='2');
 assert.equal(q2.counts['男'],2);assert.equal(q2.counts['女'],1); // multi 每个选中项各计一次
 const q17=qs.find(q=>q.id==='17a');
 assert.equal(q17.counts['4'],2);assert.equal(q17.counts['7'],1);
 assert.equal(q17.counts['1'],0); // scale 全档位补零
 const q49=qs.find(q=>q.id==='49');
 assert.equal(q49.counts,null);assert.equal(q49.answered,1); // text 只计已填写
 const q3=qs.find(q=>q.id==='3');
 assert.equal(q3.answered,0);
});

test('deep aggregation counts choice fields and skips free-text values',()=>{
 const schema=store.current('deep');
 const rows=[
  {data:{sex:'男',grade:'大一',self_description:'你好'}},
  {data:{sex:'女',grade:'大一'}},
  {data:{}},
 ];
 const qs=aggregate('deep',schema,rows);
 const sex=qs.find(q=>q.id==='sex');
 assert.ok(sex);assert.equal(sex.counts['男'],1);assert.equal(sex.counts['女'],1);
 const desc=qs.find(q=>q.id==='self_description');
 assert.equal(desc.answered,1);assert.ok(desc.counts===null||desc.counts===undefined);
});

test('buddy aggregation counts per-card field values across types',()=>{
 const schema=store.current('buddy');
 const rows=[
  {v:{item:'羽毛球',level:'新手',want:['新手','都行'],gender:'男'}},
  {v:{item:'篮球',level:'新手'}},
 ];
 const qs=aggregate('buddy',schema,rows);
 const item=qs.find(q=>q.id==='item');
 assert.equal(item.counts['羽毛球'],1);assert.equal(item.counts['篮球'],1);
 assert.equal(item.counts['足球'],0); // 无人选的选项补零
 const level=qs.find(q=>q.id==='level');
 assert.equal(level.counts['新手'],2);
 const want=qs.find(q=>q.id==='want');
 assert.equal(want.counts['都行'],1);assert.equal(want.counts['很强'],0);
});

test('unknown kind throws',()=>{
 assert.throws(()=>aggregate('nope',{},[]),/未知问卷类型/);
});
