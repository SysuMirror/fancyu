'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateProfile } = require('../profile-validation');
const valid = () => ({ profile_id: 'My_profile', avatar: '', bio: '你好', tags: ['摄影'], photos: [] });

test('normalizes IDs and tags while preserving literal text', () => {
    const profile = validateProfile({ ...valid(), bio: '<script>alert(1)</script>', tags: [' 摄影 ', '摄影'] });
    assert.equal(profile.profile_id, 'my_profile');
    assert.deepEqual(profile.tags, ['摄影']);
    assert.equal(profile.bio, '<script>alert(1)</script>');
});
test('rejects incomplete, unsafe, and oversized input', () => {
    for (const body of [null, [], {}, { ...valid(), profile_id: '../x' }, { ...valid(), profile_id: 'abc'.repeat(10) },
        { ...valid(), bio: '你'.repeat(301) }, { ...valid(), tags: ['x'.repeat(13)] }, { ...valid(), tags: Array(13).fill('a') },
        { ...valid(), avatar: 'https://example.com/avatar.jpg' }, { ...valid(), avatar: 'data:image/svg+xml;base64,PHN2Zz4=' },
        { ...valid(), avatar: 'data:image/jpeg;base64,YmFk' }, { ...valid(), avatar: 'data:image/jpeg;base64,' + 'A'.repeat(500000) },
        { ...valid(), photos: Array(7).fill('x') }, { ...valid(), photos: 'not an array' }, { ...valid(), tags: [null] }]) {
        assert.throws(() => validateProfile(body));
    }
});
test('counts Unicode characters, supports clearing optional fields', () => {
    assert.equal(Array.from(validateProfile({ ...valid(), bio: '🌱'.repeat(300) }).bio).length, 300);
    assert.deepEqual(validateProfile({ ...valid(), avatar: '', bio: '', tags: [], photos: [] }).photos, []);
});

test('allows twelve preset or custom tags and preserves legacy labels', () => {
    const tags = ['猫咪', '旅行', '音乐', '胶片', 'R&B', 'City Pop', 'Livehouse', '谷子', '观鸟', '摄影', '校园观星', '🌱'.repeat(12)];
    assert.deepEqual(validateProfile({ ...valid(), tags }).tags, tags);
    assert.throws(() => validateProfile({ ...valid(), tags: [...tags, '十三'] }));
});

test('all catalog labels are valid selectable tags', () => {
    const categories = require('../../web/profile-tags');
    assert.equal(categories.length, 12);
    for (const category of categories) {
        assert.ok(category.name);
        for (const group of category.groups) {
            assert.ok(group.tags.length > 0);
            for (const tag of group.tags) assert.deepEqual(validateProfile({ ...valid(), tags: [tag] }).tags, [tag]);
        }
    }
});
