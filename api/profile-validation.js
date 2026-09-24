'use strict';

const MAX_PHOTOS = 6;
const MAX_TAGS = 12;
const MAX_IMAGE_BYTES = 350 * 1024;
const length = value => Array.from(value).length;

function validateImage(value) {
    if (typeof value !== 'string' || value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 32 ||
        !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) {
        throw new Error('图片格式无效，请重新选择 JPG、PNG 或 WebP 图片');
    }
    const bytes = Buffer.from(value.slice(value.indexOf(',') + 1), 'base64');
    if (bytes.length < 4 || bytes.length > MAX_IMAGE_BYTES ||
        bytes[0] !== 0xff || bytes[1] !== 0xd8 ||
        bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
        throw new Error('图片无效或过大，请重新选择');
    }
    return value;
}

function validateProfile(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('主页内容无效');
    if (typeof body.profile_id !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{2,23}$/.test(body.profile_id.trim())) {
        throw new Error('主页 ID 需为 3–24 位，以字母开头，仅含字母、数字、下划线或短横线');
    }
    if (typeof body.bio !== 'string' || length(body.bio) > 300) throw new Error('个人简介不能超过 300 字');
    if (!Array.isArray(body.tags) || body.tags.length > MAX_TAGS ||
        body.tags.some(tag => typeof tag !== 'string' || !tag.trim() || length(tag.trim()) > 12)) {
        throw new Error('最多添加 12 个标签，每个标签为 1–12 字');
    }
    if (!Array.isArray(body.photos) || body.photos.length > MAX_PHOTOS) throw new Error('最多添加 6 张照片');
    if (body.avatar !== '' && typeof body.avatar !== 'string') throw new Error('头像格式无效');
    return {
        profile_id: body.profile_id.trim().toLowerCase(),
        bio: body.bio.trim(),
        avatar: body.avatar ? validateImage(body.avatar) : '',
        photos: body.photos.map(validateImage),
        tags: [...new Set(body.tags.map(tag => tag.trim()))]
    };
}

module.exports = { validateProfile, MAX_IMAGE_BYTES };
