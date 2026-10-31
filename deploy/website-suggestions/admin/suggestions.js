(() => {
    const body = document.getElementById('suggestionTable');
    const status = document.getElementById('suggestionStatus');
    const filter = document.getElementById('suggestionFilter');
    const more = document.getElementById('suggestionMore');
    const refresh = document.getElementById('suggestionRefresh');
    const retry = document.getElementById('suggestionRetry');
    let rows = [];
    let next = null;
    let revision = 0;
    let request = null;
    let writing = false;
    let uncertain = false;
    let retryCursor = null;

    function textCell(value) {
        const cell = document.createElement('td');
        cell.textContent = value ?? '';
        return cell;
    }

    function render() {
        body.replaceChildren();
        for (const item of rows) {
            const row = document.createElement('tr');
            const content = textCell(item.body);
            content.style.whiteSpace = 'pre-wrap';
            content.style.overflowWrap = 'anywhere';
            const state = document.createElement('span');
            state.className = `badge ${item.state === 'public' ? 'badge-active' : 'badge-expired'}`;
            state.textContent = item.state === 'public' ? '公开' : '已隐藏';
            const stateCell = document.createElement('td');
            stateCell.append(state);
            const actions = document.createElement('td');
            actions.className = 'actions';
            const visibility = document.createElement('button');
            visibility.type = 'button';
            visibility.textContent = item.state === 'public' ? '隐藏' : '恢复';
            visibility.disabled = writing || uncertain;
            visibility.addEventListener('click', () => void moderate(item, false));
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'btn-danger';
            remove.textContent = '删除';
            remove.disabled = writing || uncertain;
            remove.addEventListener('click', () => void moderate(item, true));
            actions.append(visibility, remove);
            row.append(textCell(item.id), textCell(item.display_name), textCell(item.account_id), content,
                stateCell, textCell(formatTime(item.created_at)), actions);
            body.append(row);
        }
        more.hidden = !next;
        more.disabled = writing || uncertain;
        filter.disabled = writing;
        refresh.disabled = writing;
    }

    function formatTime(value) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
    }

    function cancelLoad() {
        revision += 1;
        request?.abort();
        request = null;
    }

    async function readResponse(response) {
        if (!response.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
            throw new Error('invalid_response');
        }
        const value = await response.json();
        if (!response.ok) {
            const error = new Error(response.status === 401 ? 'login_required'
                : response.status === 403 ? 'forbidden' : response.status >= 500 ? 'unknown_result' : 'request_failed');
            error.status = response.status;
            throw error;
        }
        return value;
    }

    function errorText(error, isWrite) {
        if (error?.message === 'login_required') return '登录状态已失效，请重新登录。';
        if (error?.message === 'forbidden') return '没有建议管理权限，请联系管理员。';
        if (isWrite && (error?.message === 'unknown_result' || !error?.status)) {
            uncertain = true;
            return '操作结果未确认，请刷新列表核对后再操作。';
        }
        return isWrite ? '操作未完成，请刷新列表后重试。' : '建议加载失败，请重新加载。';
    }

    async function load(before = null) {
        if (writing) return;
        cancelLoad();
        const current = revision;
        const selected = filter.value;
        request = new AbortController();
        const signal = request.signal;
        status.textContent = '正在加载建议…';
        retry.hidden = true;
        more.disabled = true;
        if (!before) { rows = []; next = null; render(); }
        try {
            const query = new URLSearchParams({ state: selected });
            if (before) query.set('before', before);
            const response = await fetch(`/api/suggestions/admin?${query}`, {
                headers: headers(), credentials: 'omit', cache: 'no-store', redirect: 'error', signal,
            });
            const value = await readResponse(response);
            if (signal.aborted || current !== revision || currentTab !== 'suggestions') return;
            if (!Array.isArray(value.items) || (value.next_before !== null && typeof value.next_before !== 'string')
                || value.items.some(item => typeof item.id !== 'string' || !/^[1-9][0-9]*$/.test(item.id)
                    || typeof item.account_id !== 'string' || typeof item.body !== 'string'
                    || typeof item.display_name !== 'string' || typeof item.created_at !== 'string'
                    || !['public', 'hidden'].includes(item.state))) throw new Error('invalid_response');
            rows = before ? [...rows, ...value.items.filter(item => !rows.some(row => row.id === item.id))] : value.items;
            next = value.next_before;
            uncertain = false;
            status.textContent = rows.length ? '' : '暂无建议。';
            render();
        } catch (error) {
            if (signal.aborted || current !== revision || currentTab !== 'suggestions') return;
            retryCursor = before;
            status.textContent = errorText(error, false);
            retry.hidden = false;
            render();
        }
    }

    async function moderate(item, remove) {
        if (writing || uncertain) return;
        if (remove && !confirm('确定删除这条建议？删除后无法在管理页面恢复。')) return;
        const startedAt = revision;
        const authenticatedAs = token;
        writing = true;
        render();
        try {
            const response = await fetch(`/api/suggestions/admin/${encodeURIComponent(item.id)}`, {
                method: remove ? 'DELETE' : 'PATCH', headers: headers(), credentials: 'omit',
                cache: 'no-store', redirect: 'error',
                ...(!remove ? { body: JSON.stringify({ hidden: item.state === 'public' }) } : {}),
            });
            const value = await readResponse(response);
            if (revision !== startedAt || token !== authenticatedAs) return;
            const expectedState = remove ? 'deleted' : item.state === 'public' ? 'hidden' : 'public';
            if (value?.id !== item.id || value?.state !== expectedState) throw new Error('invalid_response');
            rows = rows.map(row => row.id === item.id ? { ...row, state: value.state } : row)
                .filter(row => row.state !== 'deleted' && (filter.value === 'all' || row.state === filter.value));
            if (currentTab === 'suggestions') showToast(remove ? '建议已删除' : expectedState === 'hidden' ? '建议已隐藏' : '建议已恢复');
            status.textContent = rows.length ? '' : '暂无建议。';
        } catch (error) {
            if (revision === startedAt && token === authenticatedAs && currentTab === 'suggestions') showToast(errorText(error, true), true);
        } finally {
            writing = false;
            render();
            if ((revision !== startedAt || token !== authenticatedAs) && currentTab === 'suggestions'
                && token && document.getElementById('app').style.display === 'block') void load();
        }
    }

    filter.addEventListener('change', () => void load());
    more.addEventListener('click', () => void load(next));
    refresh.addEventListener('click', () => void load());
    retry.addEventListener('click', () => void load(rows.length ? retryCursor : null));
    window.loadSuggestions = () => void load();
    window.cancelSuggestionLoad = cancelLoad;
})();
