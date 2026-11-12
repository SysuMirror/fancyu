'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {sanitizeDraft:sanitizeWeekly}=require('../weekly');
const {sanitizeDraft:sanitizeDeep}=require('../deep-draft');

test('weekly draft sanitizer accepts partial dirty answers without full validation',()=>{
 const d=sanitizeWeekly({answers:{'1':3,'12':null},important:['17','17','x']});
 assert.deepEqual(d,{answers:{'1':3,'12':null},important:['17','x']});
 // 草稿允许缺字段、空对象
 assert.deepEqual(sanitizeWeekly({answers:{}}),{answers:{},important:[]});
 assert.deepEqual(sanitizeWeekly({important:['47']}),{answers:{},important:['47']});
});
test('weekly draft sanitizer rejects malformed payloads',()=>{
 assert.equal(sanitizeWeekly(null),null);
 assert.equal(sanitizeWeekly({}),null); // 什么都没有
 assert.equal(sanitizeWeekly({answers:'nope'}),null);
 assert.equal(sanitizeWeekly({answers:['a']}),null);
 assert.equal(sanitizeWeekly({answers:{},important:'17'}),null);
 assert.deepEqual(sanitizeWeekly({answers:{},important:[1,2]}),{answers:{},important:[]}); // 非字符串条目被过滤
 const big={answers:{}};for(let i=0;i<200;i++)big.answers['x'+i]='y'.repeat(400);
 assert.equal(sanitizeWeekly(big),null); // 超过 64KB
});
test('weekly draft sanitizer caps important to 5 unique strings',()=>{
 const d=sanitizeWeekly({answers:{},important:['1','2','3','4','5','6','7']});
 assert.deepEqual(d.important,['1','2','3','4','5']);
});
test('deep draft sanitizer accepts plain object data and rejects the rest',()=>{
 assert.deepEqual(sanitizeDeep({data:{nickname:'阿明',photos:[]}}),{nickname:'阿明',photos:[]});
 assert.equal(sanitizeDeep(null),null);
 assert.equal(sanitizeDeep({}),null);
 assert.equal(sanitizeDeep({data:'text'}),null);
 assert.equal(sanitizeDeep({data:['a']}),null);
 const big={};for(let i=0;i<400;i++)big['k'+i]='v'.repeat(400);
 assert.equal(sanitizeDeep({data:big}),null); // 超过 128KB
});
