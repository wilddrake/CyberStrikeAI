// WebShell 管理（类似冰蝎/蚁剑：虚拟终端、文件管理、命令执行）

const WEBSHELL_SIDEBAR_WIDTH_KEY = 'webshell_sidebar_width';
const WEBSHELL_DEFAULT_SIDEBAR_WIDTH = 360;
const WEBSHELL_PROMPT = 'shell> ';
let webshellConnections = [];
let currentWebshellId = null;
let webshellTerminalInstance = null;
let webshellTerminalFitAddon = null;
let webshellTerminalResizeObserver = null;
let webshellTerminalResizeContainer = null;
let webshellCurrentConn = null;
let webshellLineBuffer = '';
let webshellRunning = false;

// 从服务端（SQLite）拉取连接列表
function getWebshellConnections() {
    if (typeof apiFetch === 'undefined') {
        return Promise.resolve([]);
    }
    return apiFetch('/api/webshell/connections', { method: 'GET' })
        .then(function (r) { return r.json(); })
        .then(function (list) { return Array.isArray(list) ? list : []; })
        .catch(function (e) {
            console.warn('读取 WebShell 连接列表失败', e);
            return [];
        });
}

// 从服务端刷新连接列表并重绘侧栏
function refreshWebshellConnectionsFromServer() {
    return getWebshellConnections().then(function (list) {
        webshellConnections = list;
        renderWebshellList();
        return list;
    });
}

// 使用 wsT 避免与全局 window.t 冲突导致无限递归
function wsT(key) {
    var globalT = typeof window !== 'undefined' ? window.t : null;
    if (typeof globalT === 'function' && globalT !== wsT) return globalT(key);
    var fallback = {
        'webshell.title': 'WebShell 管理',
        'webshell.addConnection': '添加连接',
        'webshell.cmdParam': '命令参数名',
        'webshell.cmdParamPlaceholder': '不填默认为 cmd，如填 xxx 则请求为 xxx=命令',
        'webshell.connections': '连接列表',
        'webshell.noConnections': '暂无连接，请点击「添加连接」',
        'webshell.selectOrAdd': '请从左侧选择连接，或添加新的 WebShell 连接',
        'webshell.deleteConfirm': '确定要删除该连接吗？',
        'webshell.editConnection': '编辑',
        'webshell.editConnectionTitle': '编辑连接',
        'webshell.tabTerminal': '虚拟终端',
        'webshell.tabFileManager': '文件管理',
        'webshell.terminalWelcome': 'WebShell 虚拟终端 — 输入命令后按回车执行（Ctrl+L 清屏）',
        'webshell.filePath': '当前路径',
        'webshell.listDir': '列出目录',
        'webshell.readFile': '读取',
        'webshell.editFile': '编辑',
        'webshell.deleteFile': '删除',
        'webshell.saveFile': '保存',
        'webshell.cancelEdit': '取消',
        'webshell.parentDir': '上级目录',
        'webshell.execError': '执行失败',
        'webshell.testConnectivity': '测试连通性',
        'webshell.testSuccess': '连通性正常，Shell 可访问',
        'webshell.testFailed': '连通性测试失败',
        'webshell.testNoExpectedOutput': 'Shell 返回了响应但未得到预期输出，请检查连接密码与命令参数名',
        'common.delete': '删除',
        'common.refresh': '刷新'
    };
    return fallback[key] || key;
}

// 初始化 WebShell 管理页面（从 SQLite 拉取连接列表）
function initWebshellPage() {
    destroyWebshellTerminal();
    webshellCurrentConn = null;
    currentWebshellId = null;
    webshellConnections = [];
    renderWebshellList();
    applyWebshellSidebarWidth();
    initWebshellSidebarResize();
    const workspace = document.getElementById('webshell-workspace');
    if (workspace) {
        workspace.innerHTML = '<div class="webshell-workspace-placeholder" data-i18n="webshell.selectOrAdd">' + (wsT('webshell.selectOrAdd')) + '</div>';
    }
    getWebshellConnections().then(function (list) {
        webshellConnections = list;
        renderWebshellList();
    });
}

function getWebshellSidebarWidth() {
    try {
        const w = parseInt(localStorage.getItem(WEBSHELL_SIDEBAR_WIDTH_KEY), 10);
        if (!isNaN(w) && w >= 260 && w <= 800) return w;
    } catch (e) {}
    return WEBSHELL_DEFAULT_SIDEBAR_WIDTH;
}

function setWebshellSidebarWidth(px) {
    localStorage.setItem(WEBSHELL_SIDEBAR_WIDTH_KEY, String(px));
}

function applyWebshellSidebarWidth() {
    const sidebar = document.getElementById('webshell-sidebar');
    if (sidebar) sidebar.style.width = getWebshellSidebarWidth() + 'px';
}

function initWebshellSidebarResize() {
    const handle = document.getElementById('webshell-resize-handle');
    const sidebar = document.getElementById('webshell-sidebar');
    if (!handle || !sidebar || handle.dataset.resizeBound === '1') return;
    handle.dataset.resizeBound = '1';
    let startX = 0, startW = 0;
    function onMove(e) {
        const dx = e.clientX - startX;
        let w = Math.round(startW + dx);
        const min = 260;
        const max = Math.min(800, Math.floor((sidebar.parentElement && sidebar.parentElement.offsetWidth || 800) * 0.6));
        w = Math.max(min, Math.min(max, w));
        sidebar.style.width = w + 'px';
    }
    function onUp() {
        handle.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        setWebshellSidebarWidth(parseInt(sidebar.style.width, 10) || WEBSHELL_DEFAULT_SIDEBAR_WIDTH);
    }
    handle.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return;
        e.preventDefault();
        startX = e.clientX;
        startW = sidebar.offsetWidth;
        handle.classList.add('active');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

// 销毁当前终端实例（切换连接或离开页面时）
function destroyWebshellTerminal() {
    if (webshellTerminalResizeObserver && webshellTerminalResizeContainer) {
        try { webshellTerminalResizeObserver.unobserve(webshellTerminalResizeContainer); } catch (e) {}
        webshellTerminalResizeObserver = null;
        webshellTerminalResizeContainer = null;
    }
    if (webshellTerminalInstance) {
        try {
            webshellTerminalInstance.dispose();
        } catch (e) {}
        webshellTerminalInstance = null;
    }
    webshellTerminalFitAddon = null;
    webshellLineBuffer = '';
    webshellRunning = false;
}

// 渲染连接列表
function renderWebshellList() {
    const listEl = document.getElementById('webshell-list');
    if (!listEl) return;

    if (!webshellConnections.length) {
        listEl.innerHTML = '<div class="webshell-empty" data-i18n="webshell.noConnections">' + (wsT('webshell.noConnections')) + '</div>';
        return;
    }

    listEl.innerHTML = webshellConnections.map(conn => {
        const remark = (conn.remark || conn.url || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const url = (conn.url || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const urlTitle = (conn.url || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        const active = currentWebshellId === conn.id ? ' active' : '';
        const safeId = escapeHtml(conn.id);
        return (
            '<div class="webshell-item' + active + '" data-id="' + safeId + '">' +
            '<div class="webshell-item-remark" title="' + urlTitle + '">' + remark + '</div>' +
            '<div class="webshell-item-url" title="' + urlTitle + '">' + url + '</div>' +
            '<div class="webshell-item-actions">' +
            '<button type="button" class="btn-ghost btn-sm webshell-edit-conn-btn" data-id="' + safeId + '" title="' + wsT('webshell.editConnection') + '">' + wsT('webshell.editConnection') + '</button> ' +
            '<button type="button" class="btn-ghost btn-sm webshell-delete-btn" data-id="' + safeId + '" title="' + wsT('common.delete') + '">' + wsT('common.delete') + '</button>' +
            '</div>' +
            '</div>'
        );
    }).join('');

    listEl.querySelectorAll('.webshell-item').forEach(el => {
        el.addEventListener('click', function (e) {
            if (e.target.closest('.webshell-delete-btn') || e.target.closest('.webshell-edit-conn-btn')) return;
            selectWebshell(el.getAttribute('data-id'));
        });
    });
    listEl.querySelectorAll('.webshell-edit-conn-btn').forEach(btn => {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            showEditWebshellModal(btn.getAttribute('data-id'));
        });
    });
    listEl.querySelectorAll('.webshell-delete-btn').forEach(btn => {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            deleteWebshell(btn.getAttribute('data-id'));
        });
    });
}

function escapeHtml(s) {
    if (!s) return '';
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}

// 选择连接：渲染终端 + 文件管理 Tab，并初始化终端
function selectWebshell(id) {
    currentWebshellId = id;
    renderWebshellList();
    const conn = webshellConnections.find(c => c.id === id);
    const workspace = document.getElementById('webshell-workspace');
    if (!workspace) return;
    if (!conn) {
        workspace.innerHTML = '<div class="webshell-workspace-placeholder">' + wsT('webshell.selectOrAdd') + '</div>';
        return;
    }

    destroyWebshellTerminal();
    webshellCurrentConn = conn;

    workspace.innerHTML =
        '<div class="webshell-tabs">' +
        '<button type="button" class="webshell-tab active" data-tab="terminal">' + wsT('webshell.tabTerminal') + '</button>' +
        '<button type="button" class="webshell-tab" data-tab="file">' + wsT('webshell.tabFileManager') + '</button>' +
        '</div>' +
        '<div id="webshell-pane-terminal" class="webshell-pane active">' +
        '<div id="webshell-terminal-container" class="webshell-terminal-container"></div>' +
        '</div>' +
        '<div id="webshell-pane-file" class="webshell-pane">' +
        '<div class="webshell-file-toolbar">' +
        '<label><span>' + wsT('webshell.filePath') + '</span> <input type="text" id="webshell-file-path" class="form-control" value="." /></label>' +
        '<button type="button" class="btn-secondary" id="webshell-list-dir">' + wsT('webshell.listDir') + '</button>' +
        '<button type="button" class="btn-ghost" id="webshell-parent-dir">' + wsT('webshell.parentDir') + '</button>' +
        '</div>' +
        '<div id="webshell-file-list" class="webshell-file-list"></div>' +
        '</div>';

    // Tab 切换
    workspace.querySelectorAll('.webshell-tab').forEach(btn => {
        btn.addEventListener('click', function () {
            const tab = btn.getAttribute('data-tab');
            workspace.querySelectorAll('.webshell-tab').forEach(b => b.classList.remove('active'));
            workspace.querySelectorAll('.webshell-pane').forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            const pane = document.getElementById('webshell-pane-' + tab);
            if (pane) pane.classList.add('active');
            if (tab === 'terminal' && webshellTerminalInstance && webshellTerminalFitAddon) {
                try { webshellTerminalFitAddon.fit(); } catch (e) {}
            }
        });
    });

    // 文件管理：列出目录、上级目录
    const pathInput = document.getElementById('webshell-file-path');
    document.getElementById('webshell-list-dir').addEventListener('click', function () {
        // 点击时用当前连接，编辑保存后立即生效
        webshellFileListDir(webshellCurrentConn, pathInput ? pathInput.value.trim() || '.' : '.');
    });
    document.getElementById('webshell-parent-dir').addEventListener('click', function () {
        const p = (pathInput && pathInput.value.trim()) || '.';
        if (p === '.' || p === '/') {
            pathInput.value = '..';
        } else {
            pathInput.value = p.replace(/\/[^/]+$/, '') || '.';
        }
        webshellFileListDir(webshellCurrentConn, pathInput.value || '.');
    });

    initWebshellTerminal(conn);
}

// ---------- 虚拟终端（xterm + 按行执行） ----------
function initWebshellTerminal(conn) {
    const container = document.getElementById('webshell-terminal-container');
    if (!container || typeof Terminal === 'undefined') {
        if (container) {
            container.innerHTML = '<p class="terminal-error">' + escapeHtml('未加载 xterm.js，请刷新页面') + '</p>';
        }
        return;
    }

    const term = new Terminal({
        cursorBlink: true,
        cursorStyle: 'underline',
        fontSize: 13,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        lineHeight: 1.2,
        scrollback: 2000,
        theme: {
            background: '#0d1117',
            foreground: '#e6edf3',
            cursor: '#58a6ff',
            cursorAccent: '#0d1117',
            selection: 'rgba(88, 166, 255, 0.3)'
        }
    });

    let fitAddon = null;
    if (typeof FitAddon !== 'undefined') {
        const FitCtor = FitAddon.FitAddon || FitAddon;
        fitAddon = new FitCtor();
        term.loadAddon(fitAddon);
    }

    term.open(container);
    // 先 fit 再写内容，避免未计算尺寸时光标/画布错位挡住文字
    try {
        if (fitAddon) fitAddon.fit();
    } catch (e) {}
    // 不再输出欢迎行，避免占用空间、挡住输入
    term.write(WEBSHELL_PROMPT);

    // 按行写入输出，与系统设置终端 writeOutput 一致，避免 ls 等输出错位
    function writeWebshellOutput(term, text, isError) {
        if (!term || !text) return;
        var s = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        var lines = s.split('\n');
        var prefix = isError ? '\x1b[31m' : '';
        var suffix = isError ? '\x1b[0m' : '';
        term.write(prefix);
        for (var i = 0; i < lines.length; i++) {
            term.writeln(lines[i].replace(/\r/g, ''));
        }
        term.write(suffix);
    }

    term.onData(function (data) {
        // Ctrl+L 清屏
        if (data === '\x0c') {
            term.clear();
            webshellLineBuffer = '';
            term.write(WEBSHELL_PROMPT);
            return;
        }
        // 回车：发送当前行到后端执行
        if (data === '\r' || data === '\n') {
            term.writeln('');
            const cmd = webshellLineBuffer.trim();
            webshellLineBuffer = '';
            if (cmd) {
                webshellRunning = true;
                // 执行时用当前连接（编辑保存后 webshellCurrentConn 已更新），避免闭包持有旧 conn
                execWebshellCommand(webshellCurrentConn, cmd).then(function (out) {
                    webshellRunning = false;
                    if (out && out.length) writeWebshellOutput(term, out, false);
                    term.write(WEBSHELL_PROMPT);
                }).catch(function (err) {
                    webshellRunning = false;
                    writeWebshellOutput(term, err && err.message ? err.message : wsT('webshell.execError'), true);
                    term.write(WEBSHELL_PROMPT);
                });
            } else {
                term.write(WEBSHELL_PROMPT);
            }
            return;
        }
        // 退格
        if (data === '\x7f' || data === '\b') {
            if (webshellLineBuffer.length > 0) {
                webshellLineBuffer = webshellLineBuffer.slice(0, -1);
                term.write('\b \b');
            }
            return;
        }
        webshellLineBuffer += data;
        term.write(data);
    });

    webshellTerminalInstance = term;
    webshellTerminalFitAddon = fitAddon;
    // 延迟再次 fit，确保容器尺寸稳定后光标与文字不错位
    setTimeout(function () {
        try { if (fitAddon) fitAddon.fit(); } catch (e) {}
    }, 100);
    // 容器尺寸变化时重新 fit，避免光标/文字被遮挡
    if (fitAddon && typeof ResizeObserver !== 'undefined' && container) {
        webshellTerminalResizeContainer = container;
        webshellTerminalResizeObserver = new ResizeObserver(function () {
            try { fitAddon.fit(); } catch (e) {}
        });
        webshellTerminalResizeObserver.observe(container);
    }
}

// 调用后端执行命令
function execWebshellCommand(conn, command) {
    return new Promise(function (resolve, reject) {
        if (typeof apiFetch === 'undefined') {
            reject(new Error('apiFetch 未定义'));
            return;
        }
        apiFetch('/api/webshell/exec', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url: conn.url,
                password: conn.password || '',
                type: conn.type || 'php',
                method: (conn.method || 'post').toLowerCase(),
                cmd_param: conn.cmdParam || '',
                command: command
            })
        }).then(function (r) { return r.json(); })
            .then(function (data) {
                if (data && data.output !== undefined) resolve(data.output || '');
                else if (data && data.error) reject(new Error(data.error));
                else resolve('');
            })
            .catch(reject);
    });
}

// ---------- 文件管理 ----------
function webshellFileListDir(conn, path) {
    const listEl = document.getElementById('webshell-file-list');
    if (!listEl) return;
    listEl.innerHTML = '<div class="webshell-loading">' + wsT('common.refresh') + '...</div>';

    if (typeof apiFetch === 'undefined') {
        listEl.innerHTML = '<div class="webshell-file-error">apiFetch 未定义</div>';
        return;
    }

    apiFetch('/api/webshell/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            url: conn.url,
            password: conn.password || '',
            type: conn.type || 'php',
            method: (conn.method || 'post').toLowerCase(),
            cmd_param: conn.cmdParam || '',
            action: 'list',
            path: path
        })
    }).then(function (r) { return r.json(); })
        .then(function (data) {
            if (!data.ok && data.error) {
                listEl.innerHTML = '<div class="webshell-file-error">' + escapeHtml(data.error) + '</div><pre class="webshell-file-raw">' + escapeHtml(data.output || '') + '</pre>';
                return;
            }
            renderFileList(listEl, path, data.output || '', conn);
        })
        .catch(function (err) {
            listEl.innerHTML = '<div class="webshell-file-error">' + escapeHtml(err && err.message ? err.message : wsT('webshell.execError')) + '</div>';
        });
}

function renderFileList(listEl, currentPath, rawOutput, conn) {
    // 解析 ls -la 风格输出为简单列表（兼容不同格式）
    const lines = rawOutput.split(/\n/).filter(function (l) { return l.trim(); });
    const items = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const m = line.match(/\s*(\S+)\s*$/); // 最后一列作为名称
        const name = m ? m[1].trim() : line.trim();
        if (name === '.' || name === '..') continue;
        const isDir = line.startsWith('d') || line.toLowerCase().indexOf('<dir>') !== -1;
        items.push({ name: name, isDir: isDir, line: line });
    }

    let html = '';
    if (items.length === 0 && rawOutput.trim()) {
        html = '<pre class="webshell-file-raw">' + escapeHtml(rawOutput) + '</pre>';
    } else {
    html = '<table class="webshell-file-table"><thead><tr><th>' + wsT('webshell.filePath') + '</th><th></th></tr></thead><tbody>';
    if (currentPath !== '.' && currentPath !== '') {
        html += '<tr><td><a href="#" class="webshell-file-link" data-path="' + escapeHtml(currentPath.replace(/\/[^/]+$/, '') || '.') + '" data-isdir="1">..</a></td><td></td></tr>';
    }
    items.forEach(function (item) {
        const pathNext = currentPath === '.' ? item.name : currentPath + '/' + item.name;
        html += '<tr><td><a href="#" class="webshell-file-link" data-path="' + escapeHtml(pathNext) + '" data-isdir="' + (item.isDir ? '1' : '0') + '">' + escapeHtml(item.name) + (item.isDir ? '/' : '') + '</a></td><td>';
        if (!item.isDir) {
            html += '<button type="button" class="btn-ghost btn-sm webshell-file-read" data-path="' + escapeHtml(pathNext) + '">' + wsT('webshell.readFile') + '</button> ';
            html += '<button type="button" class="btn-ghost btn-sm webshell-file-edit" data-path="' + escapeHtml(pathNext) + '">' + wsT('webshell.editFile') + '</button> ';
            html += '<button type="button" class="btn-ghost btn-sm webshell-file-del" data-path="' + escapeHtml(pathNext) + '">' + wsT('webshell.deleteFile') + '</button>';
        }
        html += '</td></tr>';
    });
    html += '</tbody></table>';
    }
    listEl.innerHTML = html;

    listEl.querySelectorAll('.webshell-file-link').forEach(function (a) {
        a.addEventListener('click', function (e) {
            e.preventDefault();
            const path = a.getAttribute('data-path');
            const isDir = a.getAttribute('data-isdir') === '1';
            const pathInput = document.getElementById('webshell-file-path');
            if (pathInput) pathInput.value = path;
            if (isDir) webshellFileListDir(webshellCurrentConn, path);
            else webshellFileRead(webshellCurrentConn, path, listEl);
        });
    });
    listEl.querySelectorAll('.webshell-file-read').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            webshellFileRead(webshellCurrentConn, btn.getAttribute('data-path'), listEl);
        });
    });
    listEl.querySelectorAll('.webshell-file-edit').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            webshellFileEdit(webshellCurrentConn, btn.getAttribute('data-path'), listEl);
        });
    });
    listEl.querySelectorAll('.webshell-file-del').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            if (!confirm(wsT('webshell.deleteConfirm'))) return;
            webshellFileDelete(webshellCurrentConn, btn.getAttribute('data-path'), function () {
                webshellFileListDir(webshellCurrentConn, document.getElementById('webshell-file-path').value.trim() || '.');
            });
        });
    });
}

function webshellFileRead(conn, path, listEl) {
    if (typeof apiFetch === 'undefined') return;
    listEl.innerHTML = '<div class="webshell-loading">' + wsT('webshell.readFile') + '...</div>';
    apiFetch('/api/webshell/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: conn.url, password: conn.password || '', type: conn.type || 'php', method: (conn.method || 'post').toLowerCase(), cmd_param: conn.cmdParam || '', action: 'read', path: path })
    }).then(function (r) { return r.json(); })
        .then(function (data) {
            const out = (data && data.output) ? data.output : (data.error || '');
            listEl.innerHTML = '<div class="webshell-file-content"><pre>' + escapeHtml(out) + '</pre><button type="button" class="btn-ghost" onclick="webshellFileListDir(webshellCurrentConn, document.getElementById(\'webshell-file-path\').value.trim() || \'.\')">' + wsT('webshell.listDir') + '</button></div>';
        })
        .catch(function (err) {
            listEl.innerHTML = '<div class="webshell-file-error">' + escapeHtml(err && err.message ? err.message : '') + '</div>';
        });
}

function webshellFileEdit(conn, path, listEl) {
    if (typeof apiFetch === 'undefined') return;
    listEl.innerHTML = '<div class="webshell-loading">' + wsT('webshell.editFile') + '...</div>';
    apiFetch('/api/webshell/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: conn.url, password: conn.password || '', type: conn.type || 'php', method: (conn.method || 'post').toLowerCase(), cmd_param: conn.cmdParam || '', action: 'read', path: path })
    }).then(function (r) { return r.json(); })
        .then(function (data) {
            const content = (data && data.output) ? data.output : (data.error || '');
            const pathInput = document.getElementById('webshell-file-path');
            const currentPath = pathInput ? pathInput.value.trim() || '.' : '.';
            listEl.innerHTML =
                '<div class="webshell-file-edit-wrap">' +
                '<div class="webshell-file-edit-path">' + escapeHtml(path) + '</div>' +
                '<textarea id="webshell-edit-textarea" class="webshell-file-edit-textarea" rows="18">' + escapeHtml(content) + '</textarea>' +
                '<div class="webshell-file-edit-actions">' +
                '<button type="button" class="btn-primary btn-sm" id="webshell-edit-save">' + wsT('webshell.saveFile') + '</button> ' +
                '<button type="button" class="btn-ghost btn-sm" id="webshell-edit-cancel">' + wsT('webshell.cancelEdit') + '</button>' +
                '</div></div>';
            document.getElementById('webshell-edit-save').addEventListener('click', function () {
                const textarea = document.getElementById('webshell-edit-textarea');
                const newContent = textarea ? textarea.value : '';
                webshellFileWrite(webshellCurrentConn, path, newContent, function () {
                    webshellFileListDir(webshellCurrentConn, currentPath);
                }, listEl);
            });
            document.getElementById('webshell-edit-cancel').addEventListener('click', function () {
                webshellFileListDir(webshellCurrentConn, currentPath);
            });
        })
        .catch(function (err) {
            listEl.innerHTML = '<div class="webshell-file-error">' + escapeHtml(err && err.message ? err.message : '') + '</div>';
        });
}

function webshellFileWrite(conn, path, content, onDone, listEl) {
    if (typeof apiFetch === 'undefined') return;
    if (listEl) listEl.innerHTML = '<div class="webshell-loading">' + wsT('webshell.saveFile') + '...</div>';
    apiFetch('/api/webshell/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: conn.url, password: conn.password || '', type: conn.type || 'php', method: (conn.method || 'post').toLowerCase(), cmd_param: conn.cmdParam || '', action: 'write', path: path, content: content })
    }).then(function (r) { return r.json(); })
        .then(function (data) {
            if (data && !data.ok && data.error && listEl) {
                listEl.innerHTML = '<div class="webshell-file-error">' + escapeHtml(data.error) + '</div><pre class="webshell-file-raw">' + escapeHtml(data.output || '') + '</pre>';
                return;
            }
            if (onDone) onDone();
        })
        .catch(function (err) {
            if (listEl) listEl.innerHTML = '<div class="webshell-file-error">' + escapeHtml(err && err.message ? err.message : wsT('webshell.execError')) + '</div>';
        });
}

function webshellFileDelete(conn, path, onDone) {
    if (typeof apiFetch === 'undefined') return;
    apiFetch('/api/webshell/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: conn.url, password: conn.password || '', type: conn.type || 'php', method: (conn.method || 'post').toLowerCase(), cmd_param: conn.cmdParam || '', action: 'delete', path: path })
    }).then(function (r) { return r.json(); })
        .then(function () { if (onDone) onDone(); })
        .catch(function () { if (onDone) onDone(); });
}

// 删除连接（请求服务端删除后刷新列表）
function deleteWebshell(id) {
    if (!confirm(wsT('webshell.deleteConfirm'))) return;
    if (currentWebshellId === id) destroyWebshellTerminal();
    if (currentWebshellId === id) currentWebshellId = null;
    if (typeof apiFetch === 'undefined') return;
    apiFetch('/api/webshell/connections/' + encodeURIComponent(id), { method: 'DELETE' })
        .then(function () {
            return refreshWebshellConnectionsFromServer();
        })
        .then(function () {
            const workspace = document.getElementById('webshell-workspace');
            if (workspace) {
                workspace.innerHTML = '<div class="webshell-workspace-placeholder">' + wsT('webshell.selectOrAdd') + '</div>';
            }
        })
        .catch(function (e) {
            console.warn('删除 WebShell 连接失败', e);
            refreshWebshellConnectionsFromServer();
        });
}

// 打开添加连接弹窗
function showAddWebshellModal() {
    var editIdEl = document.getElementById('webshell-edit-id');
    if (editIdEl) editIdEl.value = '';
    document.getElementById('webshell-url').value = '';
    document.getElementById('webshell-password').value = '';
    document.getElementById('webshell-type').value = 'php';
    document.getElementById('webshell-method').value = 'post';
    document.getElementById('webshell-cmd-param').value = '';
    document.getElementById('webshell-remark').value = '';
    var titleEl = document.getElementById('webshell-modal-title');
    if (titleEl) titleEl.textContent = wsT('webshell.addConnection');
    var modal = document.getElementById('webshell-modal');
    if (modal) modal.style.display = 'block';
}

// 打开编辑连接弹窗（预填当前连接信息）
function showEditWebshellModal(connId) {
    var conn = webshellConnections.find(function (c) { return c.id === connId; });
    if (!conn) return;
    var editIdEl = document.getElementById('webshell-edit-id');
    if (editIdEl) editIdEl.value = conn.id;
    document.getElementById('webshell-url').value = conn.url || '';
    document.getElementById('webshell-password').value = conn.password || '';
    document.getElementById('webshell-type').value = conn.type || 'php';
    document.getElementById('webshell-method').value = (conn.method || 'post').toLowerCase();
    document.getElementById('webshell-cmd-param').value = conn.cmdParam || '';
    document.getElementById('webshell-remark').value = conn.remark || '';
    var titleEl = document.getElementById('webshell-modal-title');
    if (titleEl) titleEl.textContent = wsT('webshell.editConnectionTitle');
    var modal = document.getElementById('webshell-modal');
    if (modal) modal.style.display = 'block';
}

// 关闭弹窗
function closeWebshellModal() {
    var editIdEl = document.getElementById('webshell-edit-id');
    if (editIdEl) editIdEl.value = '';
    var modal = document.getElementById('webshell-modal');
    if (modal) modal.style.display = 'none';
}

// 语言切换时刷新 WebShell 页面内所有由 JS 生成的文案（不重建终端）
function refreshWebshellUIOnLanguageChange() {
    var page = typeof window.currentPage === 'function' ? window.currentPage() : (window.currentPage || '');
    if (page !== 'webshell') return;

    renderWebshellList();

    var workspace = document.getElementById('webshell-workspace');
    if (workspace) {
        if (!currentWebshellId || !webshellCurrentConn) {
            workspace.innerHTML = '<div class="webshell-workspace-placeholder" data-i18n="webshell.selectOrAdd">' + wsT('webshell.selectOrAdd') + '</div>';
        } else {
            // 只更新标签文案，不重建终端
            var tabTerminal = workspace.querySelector('.webshell-tab[data-tab="terminal"]');
            var tabFile = workspace.querySelector('.webshell-tab[data-tab="file"]');
            if (tabTerminal) tabTerminal.textContent = wsT('webshell.tabTerminal');
            if (tabFile) tabFile.textContent = wsT('webshell.tabFileManager');

            var pathLabel = workspace.querySelector('.webshell-file-toolbar label span');
            var listDirBtn = document.getElementById('webshell-list-dir');
            var parentDirBtn = document.getElementById('webshell-parent-dir');
            if (pathLabel) pathLabel.textContent = wsT('webshell.filePath');
            if (listDirBtn) listDirBtn.textContent = wsT('webshell.listDir');
            if (parentDirBtn) parentDirBtn.textContent = wsT('webshell.parentDir');

            var pathInput = document.getElementById('webshell-file-path');
            var fileListEl = document.getElementById('webshell-file-list');
            if (fileListEl && webshellCurrentConn && pathInput) {
                webshellFileListDir(webshellCurrentConn, pathInput.value.trim() || '.');
            }
        }
    }

    var modal = document.getElementById('webshell-modal');
    if (modal && modal.style.display === 'block') {
        var titleEl = document.getElementById('webshell-modal-title');
        var editIdEl = document.getElementById('webshell-edit-id');
        if (titleEl) {
            titleEl.textContent = (editIdEl && editIdEl.value) ? wsT('webshell.editConnectionTitle') : wsT('webshell.addConnection');
        }
        if (typeof window.applyTranslations === 'function') {
            window.applyTranslations(modal);
        }
    }
}

document.addEventListener('languagechange', function () {
    refreshWebshellUIOnLanguageChange();
});

// 测试连通性（不保存，仅用当前表单参数请求 Shell 执行 echo 1）
function testWebshellConnection() {
    var url = (document.getElementById('webshell-url') || {}).value;
    if (url && typeof url.trim === 'function') url = url.trim();
    if (!url) {
        alert(wsT('webshell.url') ? (wsT('webshell.url') + ' 必填') : '请填写 Shell 地址');
        return;
    }
    var password = (document.getElementById('webshell-password') || {}).value;
    if (password && typeof password.trim === 'function') password = password.trim(); else password = '';
    var type = (document.getElementById('webshell-type') || {}).value || 'php';
    var method = ((document.getElementById('webshell-method') || {}).value || 'post').toLowerCase();
    var cmdParam = (document.getElementById('webshell-cmd-param') || {}).value;
    if (cmdParam && typeof cmdParam.trim === 'function') cmdParam = cmdParam.trim(); else cmdParam = '';
    var btn = document.getElementById('webshell-test-btn');
    if (btn) { btn.disabled = true; btn.textContent = (typeof wsT === 'function' ? wsT('common.refresh') : '刷新') + '...'; }
    if (typeof apiFetch === 'undefined') {
        if (btn) { btn.disabled = false; btn.textContent = wsT('webshell.testConnectivity'); }
        alert(wsT('webshell.testFailed') || '连通性测试失败');
        return;
    }
    apiFetch('/api/webshell/exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            url: url,
            password: password || '',
            type: type,
            method: method === 'get' ? 'get' : 'post',
            cmd_param: cmdParam || '',
            command: 'echo 1'
        })
    })
        .then(function (r) { return r.json(); })
        .then(function (data) {
            if (btn) { btn.disabled = false; btn.textContent = wsT('webshell.testConnectivity'); }
            if (!data) {
                alert(wsT('webshell.testFailed') || '连通性测试失败');
                return;
            }
            // 仅 HTTP 200 不算通过，需校验是否真的执行了 echo 1（响应体 trim 后应为 "1"）
            var output = (data.output != null) ? String(data.output).trim() : '';
            var reallyOk = data.ok && output === '1';
            if (reallyOk) {
                alert(wsT('webshell.testSuccess') || '连通性正常，Shell 可访问');
            } else {
                var msg;
                if (data.ok && output !== '1')
                    msg = wsT('webshell.testNoExpectedOutput') || 'Shell 返回了响应但未得到预期输出，请检查连接密码与命令参数名';
                else
                    msg = (data.error) ? data.error : (wsT('webshell.testFailed') || '连通性测试失败');
                if (data.http_code) msg += ' (HTTP ' + data.http_code + ')';
                alert(msg);
            }
        })
        .catch(function (e) {
            if (btn) { btn.disabled = false; btn.textContent = wsT('webshell.testConnectivity'); }
            alert((wsT('webshell.testFailed') || '连通性测试失败') + ': ' + (e && e.message ? e.message : String(e)));
        });
}

// 保存连接（新建或更新，请求服务端写入 SQLite 后刷新列表）
function saveWebshellConnection() {
    var url = (document.getElementById('webshell-url') || {}).value;
    if (url && typeof url.trim === 'function') url = url.trim();
    if (!url) {
        alert('请填写 Shell 地址');
        return;
    }
    var password = (document.getElementById('webshell-password') || {}).value;
    if (password && typeof password.trim === 'function') password = password.trim(); else password = '';
    var type = (document.getElementById('webshell-type') || {}).value || 'php';
    var method = ((document.getElementById('webshell-method') || {}).value || 'post').toLowerCase();
    var cmdParam = (document.getElementById('webshell-cmd-param') || {}).value;
    if (cmdParam && typeof cmdParam.trim === 'function') cmdParam = cmdParam.trim(); else cmdParam = '';
    var remark = (document.getElementById('webshell-remark') || {}).value;
    if (remark && typeof remark.trim === 'function') remark = remark.trim(); else remark = '';

    var editIdEl = document.getElementById('webshell-edit-id');
    var editId = editIdEl ? editIdEl.value.trim() : '';
    var body = { url: url, password: password, type: type, method: method === 'get' ? 'get' : 'post', cmd_param: cmdParam, remark: remark || url };
    if (typeof apiFetch === 'undefined') return;

    var reqUrl = editId ? ('/api/webshell/connections/' + encodeURIComponent(editId)) : '/api/webshell/connections';
    var reqMethod = editId ? 'PUT' : 'POST';
    apiFetch(reqUrl, {
        method: reqMethod,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    })
        .then(function (r) { return r.json(); })
        .then(function () {
            closeWebshellModal();
            return refreshWebshellConnectionsFromServer();
        })
        .then(function (list) {
            // 若编辑的是当前选中的连接，同步更新 webshellCurrentConn，使终端/文件管理立即使用新配置
            if (editId && currentWebshellId === editId && Array.isArray(list)) {
                var updated = list.find(function (c) { return c.id === editId; });
                if (updated) webshellCurrentConn = updated;
            }
        })
        .catch(function (e) {
            console.warn('保存 WebShell 连接失败', e);
            alert(e && e.message ? e.message : '保存失败');
        });
}
