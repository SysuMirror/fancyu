const {test}=require('node:test'),assert=require('node:assert/strict'),{defaults}=require('../reuse-defaults');
const love=id=>require('../../web/weekly-schema').questions.find(q=>q.id===id);
const categories=require('../deep-options.json').categories;
const {validate}=require('../deep-rules');

test('deep survey facts prefill the love questionnaire',()=>{
 const out=defaults('love',{},{sex:'男',grade:'研一',own_campus:'广州东校园',major_category:'工学',major_detail:'计算机科学与技术',sex_prefer:['女'],hometown:'广东',expect_school_campuses:{'中山大学':['广州南校园','深圳校区']},interests:[{category:'球类运动',subcategories:['篮球']},{category:'阅读'},{category:'电影'}]});
 assert.equal(out['1'],'男');
 assert.deepEqual(out['5'],{degree:'硕士',year:1});
 assert.equal(out['7'],'广州东校园');
 assert.equal(out['9'],'工学 · 计算机科学与技术');
 assert.deepEqual(out['2'],['女']);
 assert.deepEqual(out['11'],{province:'广东',city:''});
 assert.deepEqual(out['8'],['广州南校园','深圳校区']);
 assert.deepEqual(out['47'],['篮球 / 足球','阅读','电影 / 剧集']);
 assert.ok(out['47'].every(x=>love('47').options.includes(x)));
});

test('love questionnaire facts prefill the deep survey',()=>{
 const out=defaults('deep',{'1':'女','2':['男','女'],'5':{degree:'硕士',year:2},'7':'广州南校园','9':'工学 · 软件工程','11':{province:'广东',city:'广州'},'8':['深圳校区','珠海校区'],'47':['跑步','阅读','电影 / 剧集','摄影']},{});
 assert.equal(out.sex,'女');assert.equal(out.grade,'研二');assert.equal(out.own_campus,'广州南校园');
 assert.equal(out.major_category,'工学');assert.equal(out.major_detail,'软件工程');
 assert.deepEqual(out.sex_prefer,['男','女']);assert.equal(out.hometown,'广东');
 assert.deepEqual(out.expect_schools,['中山大学']);
 assert.deepEqual(out.expect_school_campuses,{'中山大学':['深圳校区','珠海校区']});
 assert.ok(out.interests.length<=3&&out.interests.every(x=>categories.includes(x.category)));
 const v=validate({...out,friend_goal:'综合交友',mbti:'不确定',photos:[],contact_entries:[]});
 assert.equal(v.hometown,'广东');
});

test('unmapped categories, out-of-range values and missing surveys are omitted',()=>{
 assert.equal(defaults('love',{}, {})['2'],undefined);
 assert.equal(defaults('love',{},{hometown:'国外'})['11'],undefined);
 assert.equal(defaults('deep',{'11':{province:'海外',city:'x'}},{}).hometown,undefined);
 assert.equal(defaults('love',{}, {interests:[{category:'小动物'},{category:'音乐'}]})['47'],undefined);
 assert.equal(defaults('love',{}, {sex_prefer:['不限']})['2'].join(),'男,女');
});

test('buddy keeps gender and campus prefill',()=>{
 assert.deepEqual(defaults('buddy',{'1':'女'},{own_campus:'深圳校区'}),{gender:'女生',campus:'深圳校区'});
});
