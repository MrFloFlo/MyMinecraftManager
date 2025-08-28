(() => {
    let fmModal;
    let editorModal;
    let currentPath = '.';
    let allFiles = [];
    window.currentInstance = null;

    window.openInstanceFileManager = async function (instanceName, path = '.') {
        try {
            await fetch('/api/set-instance', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ instance: instanceName })
            });
            window.currentInstance = instanceName;
            window.openFileManager(path);
        } catch (err) {
            alert(err.message);
        }
    };

    document.addEventListener('DOMContentLoaded', () => {
        // Initialize the editorModal Bootstrap modal
        const modalEl = document.getElementById('fileEditorModal');
        editorModal = new bootstrap.Modal(modalEl);

        fmModal = new bootstrap.Modal(document.getElementById('fileManagerModal'));

        document.getElementById('fm-refresh-btn').addEventListener('click', () => {
            loadFileManager(currentPath);
        });

        document.getElementById('fm-search').addEventListener('input', (e) => {
            renderFileList(filterFiles(e.target.value));
        });

        document.getElementById('fm-upload-btn').addEventListener('click', () => {
            document.getElementById('fm-upload-input').click();
        });

        document.getElementById('fm-upload-input').addEventListener('change', handleUpload);

        document.getElementById('fm-new-file-btn').addEventListener('click', createNewFile);
        document.getElementById('fm-new-folder-btn').addEventListener('click', createNewFolder);
    });

    window.openFileManager = function (path = '.') {
        currentPath = path;
        fmModal.show();
        loadFileManager(path);
    };

    async function loadFileManager(path) {
        console.log(path);
        try {
            const url = `/api/files?instance=${encodeURIComponent(window.currentInstance)}&path=${encodeURIComponent(path)}`;
            const res = await fetch(url);
            if (!res.ok) throw new Error('Failed to load files');
            allFiles = await res.json();
            document.getElementById('fm-current-path').innerText = path;
            renderFileList(allFiles);
        } catch (err) {
            alert(err.message);
        }
    }

    window.saveEditor = async function () {
        try {
            const content = document.getElementById('editorContent').value;
            if (!editorPath) {
                alert("No file is open.");
                return;
            }

            const res = await fetch('/api/files/content', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    path: editorPath,
                    content: content
                })
            });

            if (!res.ok) {
                const text = await res.text();
                alert('Save failed: ' + text);
                return;
            }
            editorModal.hide();

            window.openInstanceFileManager(window.currentInstance, currentPath);

        } catch (err) {
            console.error(err);
            alert(err.message);
        }
    };

    window.closeEditor = function () {
        if (typeof editorModal !== 'undefined') {
            editorModal.hide();
        }

        // Optional cleanup
        document.getElementById('editorContent').value = '';
        document.getElementById('editorSearch').value = '';
        document.getElementById('fileEditorTitle').innerText = 'Editor';
        editorPath = null;
        originalContent = '';
    };

    function renderFileList(files) {
        const list = document.getElementById('fm-list');
        list.innerHTML = '';

        if (currentPath !== '.' && currentPath !== '/') {
            const upLi = document.createElement('li');
            upLi.className = 'list-group-item list-group-item-dark d-flex justify-content-between align-items-center';
            upLi.innerHTML = `
                <div>
                  <i class="bi bi-folder"></i>
                  <span class="ms-2" style="cursor:pointer;">..</span>
                </div>
            `;
            upLi.querySelector('span').onclick = () => {
                const newPath = parentPath(currentPath);
                window.openInstanceFileManager(window.currentInstance, newPath);
            };
            list.appendChild(upLi);
        }

        files.forEach(item => {
            const li = document.createElement('li');
            li.className = 'list-group-item list-group-item-dark d-flex justify-content-between align-items-center';

            const nameSpan = document.createElement('span');
            nameSpan.className = 'ms-2';
            nameSpan.style.cursor = 'pointer';
            nameSpan.textContent = item.name;
            nameSpan.onclick = () => {
                if (item.type === 'directory') {
                    window.openInstanceFileManager(window.currentInstance, pathJoin(currentPath, item.name));
                } else {
                    editFile(pathJoin(currentPath, item.name));
                }
            };

            li.innerHTML = `
                <div>
                  ${getIcon(item.type)}
                </div>
                <div class="flex-grow-1"></div>
                <div class="btn-group btn-group-sm">
                  <button class="btn btn-success" title="Download" onclick="downloadFile('${pathJoin(currentPath, item.name)}')">
                    <i class="bi bi-download"></i>
                  </button>
                  <button class="btn btn-primary" title="Edit" onclick="editFile('${pathJoin(currentPath, item.name)}')">
                    <i class="bi bi-pencil"></i>
                  </button>
                  <button class="btn btn-warning" title="Rename" onclick="renameFile('${pathJoin(currentPath, item.name)}')">
                    <i class="bi bi-pencil-square"></i>
                  </button>
                  <button class="btn btn-danger" title="Delete" onclick="deleteFile('${pathJoin(currentPath, item.name)}')">
                    <i class="bi bi-trash"></i>
                  </button>
                </div>
            `;

            li.querySelector('div.flex-grow-1').appendChild(nameSpan);
            list.appendChild(li);
        });
    }

    function filterFiles(search) {
        if (!search) return allFiles;
        return allFiles.filter(f => f.name.toLowerCase().includes(search.toLowerCase()));
    }

    function getIcon(type) {
        if (type === 'directory') {
            return '<i class="bi bi-folder-fill text-warning"></i>';
        } else {
            return '<i class="bi bi-file-earmark-text-fill text-info"></i>';
        }
    }

    function parentPath(path) {
        if (!path || path === '.' || path === '/') {
            return '.';
        }
        const parts = path.split('/').filter(Boolean);
        parts.pop();
        return parts.length ? parts.join('/') : '.';
    }

    function pathJoin(...parts) {
        return parts
            .filter(Boolean)
            .join('/')
            .replace(/\/+/g, '/');
    }

    window.downloadFile = function (path) {
        window.open(`/api/files/download?path=${encodeURIComponent(path)}`, '_blank');
    };

    window.editFile = async function (path) {

        try {
            const res = await fetch(`/api/files/content?path=${encodeURIComponent(path)}`);
            if (!res.ok) throw new Error('Failed to load file content');
            const content = await res.text();
            editorPath = path;
            originalContent = content;
            const titleEl = document.getElementById('fileEditorTitle');
            const contentEl = document.getElementById('editorContent');
            const searchEl = document.getElementById('editorSearch');
            if (titleEl && contentEl && searchEl) {
                titleEl.innerText = `Editing: ${path}`;
                contentEl.value = content;
                searchEl.value = '';
                editorModal.show();
            }
        } catch (err) {
            alert(err.message);
        }
    };



    window.renameFile = async function (path) {
        const newName = prompt('Enter new name:', path.split('/').pop());
        if (!newName) return;
        await postJson('/api/files/rename', { path, newName });
        window.openInstanceFileManager(window.currentInstance, currentPath);
    };

    window.deleteFile = async function (path) {
        if (!confirm(`Delete ${path}?`)) return;
        await postJson('/api/files/delete', { path });
        window.openInstanceFileManager(window.currentInstance, currentPath);
    };

    function createNewFile() {
        const name = prompt('New file name:');
        if (!name) return;
        postJson('/api/files/newfile', { path: pathJoin(currentPath, name) })
            .then(() => window.openInstanceFileManager(window.currentInstance, currentPath))
            .catch(err => alert(err.message));
    }

    function createNewFolder() {
        const name = prompt('New folder name:');
        if (!name) return;
        postJson('/api/files/newfolder', { path: pathJoin(currentPath, name) })
            .then(() => window.openInstanceFileManager(window.currentInstance, currentPath))
            .catch(err => alert(err.message));
    }

    async function handleUpload(e) {
        const file = e.target.files[0];
        if (!file) return;

        const formData = new FormData();
        formData.append('file', file);
        formData.append('path', currentPath);

        const res = await fetch('/api/files/upload', {
            method: 'POST',
            body: formData,
            credentials: 'include'
        });

        if (!res.ok) {
            const text = await res.text();
            alert('Upload failed: ' + text);
            return;
        }

        window.openInstanceFileManager(window.currentInstance, currentPath);
    }

    async function postJson(url, data) {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(text || 'Request failed.');
        }
        return res;
    }

})();
