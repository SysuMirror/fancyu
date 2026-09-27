'use strict';
const CAMPUSES = ['广州校区南校园', '广州校区北校园', '广州校区东校园', '珠海校区', '深圳校区'];
const GENDERS = ['男', '女', '非二元'];
const GRADES = ['大一', '大二', '大三', '大四', '大五及以上', '硕士', '博士'];
const dayKey = now => new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
function ageAt(birth, now) {
    const today = dayKey(now), b = String(birth).slice(0, 10);
    return Number(today.slice(0, 4)) - Number(b.slice(0, 4)) - (today.slice(5) < b.slice(5) ? 1 : 0);
}
function validateSettings(b, now = new Date()) {
    if (!b || typeof b !== 'object') throw new Error('请填写配对资料');
    if (typeof b.birth_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.birth_date) ||
        Number.isNaN(Date.parse(b.birth_date)) || new Date(b.birth_date).toISOString().slice(0,10) !== b.birth_date || ageAt(b.birth_date, now) < 18 || ageAt(b.birth_date, now) > 100) throw new Error('请输入真实出生日期，仅限年满 18 岁参与');
    if (!GENDERS.includes(b.gender) || !CAMPUSES.includes(b.campus) || !GRADES.includes(b.grade)) throw new Error('请选择性别、校区和年级');
    for (const [field, allowed] of [['genders', GENDERS], ['campuses', CAMPUSES]]) {
        if (!Array.isArray(b[field]) || !b[field].length || b[field].some(x => !allowed.includes(x))) throw new Error('请至少选择一种愿意认识的性别和一个可接受校区');
    }
    if (!Number.isInteger(b.min_age) || !Number.isInteger(b.max_age) || b.min_age < 18 || b.max_age > 100 || b.min_age > b.max_age) throw new Error('年龄偏好需为 18–100 岁，且最小年龄不能大于最大年龄');
    if (b.single_adult_student !== true || b.display_consent !== true) throw new Error('请确认参与资格与资料展示授权');
    if (!['规律早睡', '偏晚睡', '不固定'].includes(b.schedule) || !['慢慢熟悉', '日常分享', '深度交流'].includes(b.pace)) throw new Error('请选择作息和交流节奏');
    return { birth_date: b.birth_date, gender: b.gender, show_gender: b.show_gender === true, campus: b.campus, grade: b.grade,
        genders: [...new Set(b.genders)], campuses: [...new Set(b.campuses)], min_age: b.min_age, max_age: b.max_age,
        schedule: b.schedule, pace: b.pace, single_adult_student: true, display_consent: true };
}
function compatible(a, b, now) {
    const accepts = (x,y) => x.genders.includes(y.gender) && x.campuses.includes(y.campus) && ageAt(y.birth_date,now) >= x.min_age && ageAt(y.birth_date,now) <= x.max_age;
    return ageAt(a.birth_date,now) >= 18 && ageAt(b.birth_date,now) >= 18 && accepts(a,b) && accepts(b,a);
}
function score(a,b,tagsA,tagsB) {
    return tagsA.filter(x => tagsB.includes(x)).length * 3 + (a.schedule && a.schedule === b.schedule ? 1 : 0) + (a.pace && a.pace === b.pace ? 1 : 0);
}
module.exports = { CAMPUSES, GENDERS, GRADES, dayKey, ageAt, validateSettings, compatible, score };
