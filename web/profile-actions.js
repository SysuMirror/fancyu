    async function saveNickname(btn) {
        const nickname = document.getElementById('nicknameInput').value.trim();
        if (!nickname) { showToast('请输入昵称', true); return; }
        busy(btn, '保存中…');
        try {
            const res = await fetch(`${API_URL}/account/change-username`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ new_username: nickname })
            });
            const result = await res.json();
            if (result.code === 200) {
                if (result.token) { localStorage.setItem('token', result.token); authToken = result.token; }
                if (currentUser) {
                    currentUser.nickname = nickname;
                    currentUser.username = nickname;
                    localStorage.setItem('user', JSON.stringify(currentUser));
                }
                showToast('昵称修改成功');
                closeModal('nicknameModal');
                renderProfile();
            } else {
                showToast(result.msg || '修改失败', true);
            }
        } catch (err) {
            showToast('网络异常', true);
        } finally {
            idle(btn);
        }
    }

    async function savePassword(btn) {
        const oldPwd = document.getElementById('oldPassword').value;
        const newPwd = document.getElementById('newPassword').value;
        const confirmPwd = document.getElementById('confirmPassword').value;
        if (!oldPwd || !newPwd || !confirmPwd) { showToast('请填写所有密码字段', true); return; }
        if (newPwd.length < 8) { showToast('新密码至少8位', true); return; }
        if (newPwd !== confirmPwd) { showToast('两次输入的新密码不一致', true); return; }
        busy(btn, '保存中…');
        try {
            const res = await fetch(`${API_URL}/account/change-password`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ old_password: oldPwd, new_password: newPwd })
            });
            const result = await res.json();
            if (result.code === 200) {
                showToast('密码修改成功');
                closeModal('passwordModal');
                document.getElementById('oldPassword').value = '';
                document.getElementById('newPassword').value = '';
                document.getElementById('confirmPassword').value = '';
            } else {
                showToast(result.msg || '修改失败', true);
            }
        } catch (err) {
            showToast('网络异常', true);
        } finally {
            idle(btn);
        }
    }

    async function deleteAccount(btn) {
        const pwd = document.getElementById('deletePassword').value;
        if (!pwd) { showToast('请输入密码', true); return; }
        busy(btn, '注销中…');
        try {
            const res = await fetch(`${API_URL}/account/delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ password: pwd })
            });
            const result = await res.json();
            if (result.code === 200) {
                localStorage.removeItem('token');
                localStorage.removeItem('user');
                window.location.href = '/';
            } else {
                showToast(result.msg || '注销失败', true);
            }
        } catch (err) {
            showToast('网络异常', true);
        } finally {
            idle(btn);
        }
    }

    function busy(btn, label) {
        if (!btn) return;
        if (!btn.dataset.idle) { btn.dataset.idle = btn.textContent; }
        btn.disabled = true;
        btn.textContent = label || '处理中…';
    }

    function idle(btn) {
        if (!btn) return;
        btn.disabled = false;
        if (btn.dataset.idle) { btn.textContent = btn.dataset.idle; }
    }

    function showToast(msg, isError = false) {
        const toast = document.getElementById('toast');
        toast.textContent = msg;
        toast.className = isError ? 'toast show error' : 'toast show';
        setTimeout(() => toast.classList.remove('show'), 3000);
    }

