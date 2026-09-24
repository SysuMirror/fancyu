'use strict';

(() => {
    const $ = id => document.getElementById(id);
    const size = value => Array.from(value).length;
    let saved = null;
    let draft = null;
    let busy = false;
    let loading = false;
    let changed = false;
    const token = () => localStorage.getItem('token');
    const suggestions = ['摄影', '旅行', '音乐', '电影', '读书', '运动', '美食', '慢热', '猫咪', '户外'];

    async function request(method = 'GET', body) {
        const response = await fetch('/api/account/profile', {
            method,
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (token() || '') },
            ...(body ? { body: JSON.stringify(body) } : {})
        });
        const result = await response.json();
        if (!response.ok || result.code !== 200) {
            const error = new Error(result.msg || '请求失败，请稍后重试');
            error.status = response.status;
            throw error;
        }
        return result.profile;
    }

    function setStatus(message, error = false) {
        $('editStatus').textContent = message;
        $('editStatus').classList.toggle('error', error);
    }

    function renderAvatar(target, data, name) {
        target.replaceChildren();
        if (data) {
            const image = new Image();
            image.alt = '我的头像';
            image.src = data;
            target.append(image);
        } else target.textContent = Array.from(name || '我')[0].toUpperCase();
    }

    function tagElement(text, click) {
        const node = document.createElement(click ? 'button' : 'span');
        node.className = 'tag';
        node.textContent = text;
        if (click) { node.type = 'button'; node.addEventListener('click', click); }
        return node;
    }

    function render() {
        renderAvatar($('avatarView'), saved.avatar, saved.username);
        $('nameView').textContent = saved.username || '我的主页';
        $('idView').textContent = saved.profile_id ? '@' + saved.profile_id : '设置一个属于你的主页 ID';
        $('bioView').textContent = saved.bio || '还没有写简介，来介绍一下自己吧。';
        $('tagsView').replaceChildren(...saved.tags.map(tag => tagElement(tag)));
        if (!saved.tags.length) $('tagsView').textContent = '你的兴趣与个性，等你来添加。';
        $('photoCount').textContent = saved.photos.length + ' / 6';
        $('emptyPhotos').hidden = !!saved.photos.length;
        $('photosView').replaceChildren(...saved.photos.map((src, index) => {
            const button = document.createElement('button');
            button.className = 'photo-tile';
            button.type = 'button';
            button.setAttribute('aria-label', '查看第 ' + (index + 1) + ' 张照片');
            const image = new Image();
            image.alt = '我的照片 ' + (index + 1);
            image.src = src;
            button.append(image);
            button.addEventListener('click', () => { $('largePhoto').src = src; $('photoDialog').showModal(); });
            return button;
        }));
    }

    async function load() {
        if (loading) return;
        loading = true;
        $('editButton').disabled = true;
        $('loadActions').hidden = true;
        $('loadStatus').textContent = '正在加载你的主页…';
        $('loadStatus').classList.remove('error');
        try {
            saved = await request();
            render();
            $('profileContent').hidden = false;
            $('editButton').disabled = false;
            $('loadStatus').textContent = '';
        } catch (error) {
            $('loadStatus').textContent = error.status === 401 ? '请先登录，再创建你的个人主页。' : (error.message || '加载失败，请检查网络后重试');
            $('loadStatus').classList.add('error');
            $('loadActions').hidden = false;
        } finally { loading = false; }
    }

    function setBusy(value, message = '') {
        busy = value;
        $('profileForm').querySelectorAll('button,input,textarea').forEach(node => { node.disabled = value; });
        if (!value) $('choosePhotos').disabled = draft.photos.length >= 6;
        $('saveButton').textContent = value ? '处理中…' : '保存主页';
        if (message) setStatus(message);
    }

    function renderDraft() {
        renderAvatar($('avatarPreview'), draft.avatar, saved.username);
        $('removeAvatar').hidden = !draft.avatar;
        $('tagCount').textContent = draft.tags.length + ' / 8';
        $('selectedTags').replaceChildren(...draft.tags.map((tag, index) => {
            const node = tagElement(tag, () => { draft.tags.splice(index, 1); changed = true; renderDraft(); });
            node.setAttribute('aria-label', '移除标签 ' + tag);
            return node;
        }));
        $('suggestedTags').replaceChildren(...suggestions.filter(tag => !draft.tags.includes(tag)).map(tag => tagElement(tag, () => addTag(tag))));
        $('editPhotoCount').textContent = draft.photos.length + ' / 6';
        $('choosePhotos').disabled = draft.photos.length >= 6;
        $('photoPreviews').replaceChildren(...draft.photos.map((src, index) => {
            const tile = document.createElement('div');
            tile.className = 'photo-tile';
            const image = new Image();
            image.alt = '待保存照片 ' + (index + 1);
            image.src = src;
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'remove-photo';
            remove.textContent = '×';
            remove.setAttribute('aria-label', '移除第 ' + (index + 1) + ' 张照片');
            remove.addEventListener('click', () => { draft.photos.splice(index, 1); changed = true; renderDraft(); });
            tile.append(image, remove);
            return tile;
        }));
    }

    function openEditor() {
        if (!saved) return;
        draft = JSON.parse(JSON.stringify(saved));
        changed = false;
        $('profileId').value = draft.profile_id;
        $('bioInput').value = draft.bio;
        $('bioCount').textContent = size(draft.bio) + ' / 300';
        $('tagInput').value = '';
        $('avatarInput').value = '';
        $('photosInput').value = '';
        setStatus('');
        renderDraft();
        $('editor').showModal();
    }

    function closeEditor() {
        if (busy) return;
        if (changed && !window.confirm('还没有保存，确定放弃本次修改吗？')) return;
        $('editor').close();
        changed = false;
    }

    function addTag(value = $('tagInput').value) {
        const tag = value.trim();
        if (!tag) return true;
        if (size(tag) > 12) { setStatus('每个标签最多 12 字', true); return false; }
        if (draft.tags.includes(tag)) { $('tagInput').value = ''; return true; }
        if (draft.tags.length >= 8) { setStatus('最多添加 8 个标签，请先移除一个', true); return false; }
        draft.tags.push(tag);
        $('tagInput').value = '';
        changed = true;
        setStatus('');
        renderDraft();
        return true;
    }

    async function compressImage(file, avatar) {
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('请选择 JPG、PNG 或 WebP 图片');
        if (file.size > 10 * 1024 * 1024) throw new Error('单张图片不能超过 10 MB');
        const url = URL.createObjectURL(file);
        try {
            const image = new Image();
            image.src = url;
            await image.decode();
            if (!image.naturalWidth || !image.naturalHeight) throw new Error('无法读取这张图片，请换一张');
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            let maxEdge = avatar ? 256 : 1200;
            for (let attempt = 0; attempt < 5; attempt++) {
                const ratio = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
                canvas.width = avatar ? 256 : Math.max(1, Math.round(image.naturalWidth * ratio));
                canvas.height = avatar ? 256 : Math.max(1, Math.round(image.naturalHeight * ratio));
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                if (avatar) {
                    const edge = Math.min(image.naturalWidth, image.naturalHeight);
                    ctx.drawImage(image, (image.naturalWidth - edge) / 2, (image.naturalHeight - edge) / 2, edge, edge, 0, 0, 256, 256);
                } else ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
                const data = canvas.toDataURL('image/jpeg', .82 - attempt * .1);
                if (Math.ceil((data.length - 23) * .75) <= 350 * 1024) return data;
                maxEdge = Math.round(maxEdge * .75);
            }
            throw new Error('这张图片压缩后仍然过大，请选择另一张');
        } finally { URL.revokeObjectURL(url); }
    }

    async function acceptFiles(input, avatar) {
        const files = Array.from(input.files);
        if (!files.length || busy) return;
        if (!avatar && files.length + draft.photos.length > 6) {
            setStatus('最多 6 张照片，本次还可以添加 ' + (6 - draft.photos.length) + ' 张', true);
            input.value = '';
            return;
        }
        setBusy(true, '正在处理图片，请稍候…');
        try {
            const results = [];
            for (const file of files) results.push(await compressImage(file, avatar));
            if (avatar) draft.avatar = results[0];
            else draft.photos.push(...results);
            changed = true;
            renderDraft();
            setStatus('图片已准备好，保存主页后生效');
        } catch (error) { setStatus(error.message || '图片处理失败，请重新选择', true); }
        finally { input.value = ''; setBusy(false); }
    }

    $('profileForm').addEventListener('submit', async event => {
        event.preventDefault();
        if (busy || !addTag()) return;
        if (size($('bioInput').value) > 300) { setStatus('个人简介不能超过 300 字', true); $('bioInput').focus(); return; }
        draft.profile_id = $('profileId').value.trim();
        draft.bio = $('bioInput').value;
        setBusy(true, '正在保存你的主页…');
        try {
            const result = await request('PUT', draft);
            saved = result;
            changed = false;
            render();
            $('editor').close();
            $('loadStatus').textContent = '个人主页已保存';
            $('loadStatus').classList.remove('error');
        } catch (error) { setStatus(error.message || '保存失败，请检查网络后重试', true); }
        finally { setBusy(false); }
    });
    $('profileForm').addEventListener('input', () => { changed = true; });
    $('bioInput').addEventListener('input', () => {
        const count = size($('bioInput').value);
        $('bioCount').textContent = count + ' / 300';
        $('bioCount').classList.toggle('error', count > 300);
    });
    $('editButton').addEventListener('click', openEditor);
    $('addFirstPhotos').addEventListener('click', openEditor);
    $('retryButton').addEventListener('click', load);
    $('closeEditor').addEventListener('click', closeEditor);
    $('cancelEdit').addEventListener('click', closeEditor);
    $('editor').addEventListener('cancel', event => { event.preventDefault(); closeEditor(); });
    $('chooseAvatar').addEventListener('click', () => $('avatarInput').click());
    $('choosePhotos').addEventListener('click', () => $('photosInput').click());
    $('avatarInput').addEventListener('change', () => acceptFiles($('avatarInput'), true));
    $('photosInput').addEventListener('change', () => acceptFiles($('photosInput'), false));
    $('removeAvatar').addEventListener('click', () => { draft.avatar = ''; changed = true; renderDraft(); });
    $('addTag').addEventListener('click', () => addTag());
    $('tagInput').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addTag(); } });
    $('closePhoto').addEventListener('click', () => $('photoDialog').close());
    window.addEventListener('beforeunload', event => { if (changed && $('editor').open) { event.preventDefault(); event.returnValue = ''; } });
    load();
})();
