// Create websocket connection
let ws;

const TYPE_PARENT = -1;
const TYPE_FILE = 1;
const TYPE_FOLDER = 2;

let currentList;
let currentQueue;

loadTheme();
connectWebSocket();

function connectWebSocket() {
    ws = new WebSocket(((window.location.protocol === "https:") ? "wss://" : "ws://") + window.location.host + "/ws");

    ws.onmessage = (messageEvent) => {
        try {
            const message = JSON.parse(messageEvent.data);

            switch (message.type) {
                case "list":
                    loadList(message.data)
                    break;
                case "listElement":
                    loadListElement(message.data)
                    break;
                case "queue":
                    loadQueue(message.data)
                    break;
                case "queueElement":
                    loadQueueElement(message.data)
                    break;
                case "error":
                    showMessage(message.data, true)
                    break;
                case "success":
                    showMessage(message.data, false)
                    break;
            }
        } catch (e) {
            console.error(e)
        }
    }

    ws.onclose = (e) => {
        ws = null;
        console.log('WebSocket connection closed. Reconnecting in 1 second...', e.reason);
        setTimeout(connectWebSocket, 1000);
        showMessage("Lost connection to backend", true);
        document.getElementById("disconnected").classList.remove("hide")
    }

    ws.onerror = (err) => {
        console.log('WebSocket connection error:', err);
        ws.close();
    }

    ws.onopen = () => {
        showMessage("Connected to backend", false);
        if (!currentList) listPath('');
        listQueue();
        document.getElementById("disconnected").classList.add("hide")
    }
}

function loadTheme() {
    const themePref = localStorage.getItem('theme');
    if (themePref) toggleDarkMode(themePref === 'dark');
}

function listPath(path) {
    if (!ws) return;
    ws.send(JSON.stringify({
        action: "list",
        path: path
    }));
}

function listQueue() {
    ws.send(JSON.stringify({
        action: "listQueue"
    }));
}

function downloadPath(path) {
    if (!ws) return;
    ws.send(JSON.stringify({
        action: "download",
        path: path
    }));
}

function deletePath(path) {
    if (!ws) return;
    ws.send(JSON.stringify({
        action: "delete",
        path: path
    }));
}

function cancelQueueElement(path) {
    if (!ws) return;
    ws.send(JSON.stringify({
        action: "cancelQueueElement",
        path: path
    }));
}

// Loading explorer list UI

function loadList(data) {
    if (!Array.isArray(data)) return;

    currentList = data

    const body = document.getElementById("explorer");

    if (!body) return;

    body.classList.remove("loading");

    while (body.firstChild) body.removeChild(body.firstChild);

    data.forEach((element) => {
        body.appendChild(getDOMElementForListElement(element))
    })
}

function getDOMElementForListElement(listElement) {

    const tr = document.createElement("tr");

    const exists = document.createElement("td");
    const type = document.createElement("td");
    const name = document.createElement("td");
    const size = document.createElement("td");
    const deleteAction = document.createElement("td");
    const downloadAction = document.createElement("td");

    exists.classList.add("exists");
    type.classList.add("type");
    name.classList.add("name");
    size.classList.add("size");
    deleteAction.classList.add("delete");
    downloadAction.classList.add("download");

    exists.textContent = listElement.type !== TYPE_PARENT ? listElement.existsLocally ? "✅" : "❌" : "";
    type.textContent = getFileTypeIcon(listElement.type, listElement.name);
    name.textContent = listElement.name;
    name.title = listElement.path
    size.textContent = formatBytes(listElement.size ? listElement.size : 0);
    size.classList.add("size");
    if (listElement.existsLocally) {
        size.title = `Size on disk: ${formatBytes(listElement.localSize)}`;

        if (listElement.size !== listElement.localSize) {
            size.classList.add('incomplete');
            size.title += ', file incomplete'
        }
    }
    deleteAction.textContent = "🗑️";
    downloadAction.textContent = "💾"

    tr.appendChild(exists)
    tr.appendChild(type)
    tr.appendChild(name)

    if (listElement.type === TYPE_FILE) {
        tr.appendChild(size)
    }

    if (listElement.type !== TYPE_PARENT) {
        tr.appendChild(listElement.existsLocally ? deleteAction : downloadAction);
    } else {
        name.colSpan = 2;
    }

    // Clist listeners
    downloadAction.onclick = (event) => {
        event.stopPropagation();
        if (!listElement.existsLocally)
            downloadPath(listElement.path)
    }

    deleteAction.onclick = (event) => {
        event.stopPropagation();
        if (listElement.existsLocally) {
            if (confirm(`Are you sure you want to delete '${listElement.path}'?`)) {
                deletePath(listElement.path)
            }
        }
    }

    tr.onclick = () => {
        if (listElement.type === TYPE_FOLDER || listElement.type === TYPE_PARENT)
            listPath(listElement.path)
    }

    return tr;
}

// Update single explorer list element in UI

function loadListElement(data) {

    if (!data || !Array.isArray(currentList)) return;

    const index = currentList.findIndex((listEl) => {
        return listEl.path === data.path;
    })

    if (index < 0) return;

    const existingListElement = currentList[index];

    if (typeof data.localSize === 'number') {
        existingListElement.localSize = data.localSize;
    }

    if (typeof data.existsLocally === 'boolean') {
        existingListElement.existsLocally = data.existsLocally;
    }

    const domElement = getDOMElementForListElement(existingListElement);

    const parent = document.querySelector("#explorer");
    parent.childNodes[index]?.replaceWith(domElement);
}

// Loading queue UI

function loadQueue(data) {
    if (!Array.isArray(data)) return;

    currentQueue = data

    const body = document.getElementById("queue");

    if (!body) return;

    body.classList.remove("loading");

    while (body.firstChild) body.removeChild(body.firstChild);

    data.forEach((element) => {
        body.appendChild(getDOMElementForQueueElement(element));
    })
}

function getDOMElementForQueueElement(queueElement) {
    const tr = document.createElement("tr");

    const state = document.createElement("td");
    const type = document.createElement("td");
    const name = document.createElement("td");
    const progress = document.createElement("td");
    const total = document.createElement("td");
    const cancelButton = document.createElement("td");

    state.classList.add("state");
    type.classList.add("type");
    name.classList.add("name");
    progress.classList.add("progress");
    total.classList.add("total");
    cancelButton.classList.add("cancel");

    // Whole row click listener for cancel
    tr.onclick = (event) => {
        event.stopPropagation();
        if (queueElement.isDownloading) {
            if (confirm(`Are you sure you want to cancel downloading '${queueElement.path}'?`)) {
                cancelQueueElement(queueElement.path);
            }
        } else {
            cancelQueueElement(queueElement.path);
        }
    }

    state.innerText = queueElement.isDownloading ? "⬇️" : "⌛";
    state.title = queueElement.isDownloading ? "Item is downloading" : "Item is queued";
    type.innerText = getFileTypeIcon(queueElement.type, queueElement.name)
    name.innerText = queueElement.name;
    name.title = queueElement.path;
    progress.innerText = formatBytes(queueElement.progress);
    total.innerText = formatBytes(queueElement.size);
    cancelButton.innerText = "❌"

    tr.appendChild(state);
    tr.appendChild(type);
    tr.appendChild(name);
    tr.appendChild(progress);
    tr.appendChild(total);
    tr.appendChild(cancelButton);

    return tr;
}

function toggleDarkMode(force) {

    const theme = typeof force === 'boolean'
        ? force
            ? "dark"
            : "light"
        : document.documentElement.getAttribute('data-theme') !== 'light'
            ? 'light'
            : 'dark'

    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
}

// Update single queue element in UI

function loadQueueElement(data) {

    if (!data || !Array.isArray(currentQueue)) return;

    const index = currentQueue.findIndex((queueEl) => {
        return queueEl.path === data.path;
    })

    if (index < 0) return;

    const existingQueueElement = currentQueue[index];

    if (typeof data.progress === 'number') {
        existingQueueElement.progress = data.progress;
        existingQueueElement.progressUi = formatBytes(data.progress);
    }

    if (typeof data.isDownloading === 'boolean') {
        existingQueueElement.isDownloading = data.isDownloading;
    }

    if (typeof data.size === 'number') {
        existingQueueElement.size = data.size;
        existingQueueElement.sizeUi = formatBytes(data.size);
    }

    const domElement = getDOMElementForQueueElement(existingQueueElement);

    const parent = document.querySelector("#queue");
    parent.childNodes[index]?.replaceWith(domElement);
}

function showMessage(data, isError) {

    if (!data) return;

    const messagesContainer = document.getElementById("messages")

    const errorEl = document.createElement("div");
    errorEl.classList.add("message");
    errorEl.classList.add(isError ? "error" : "success");

    errorEl.textContent = data;

    messagesContainer.appendChild(errorEl);

    while (messagesContainer.childElementCount > 50) {
        messagesContainer.removeChild(messagesContainer.firstChild);
    }
}

function getFileTypeIcon(fileType, filePath) {

    switch (fileType) {
        case TYPE_FILE:
            return getFileTypeExtensionIcon(filePath);
        case TYPE_FOLDER:
            return "📁";
        case TYPE_PARENT:
            return "⬆️";
        default:
            return "❓";
    }
}

function getFileTypeExtensionIcon(filePath) {

    if (typeof filePath === 'string' && filePath) {

        const extension = filePath.toLowerCase().split('.').pop();

        switch (extension) {
            case "3g2":
            case "3gp":
            case "aaf":
            case "asf":
            case "avchd":
            case "avi":
            case "drc":
            case "flv":
            case "m2v":
            case "m4p":
            case "m4v":
            case "mkv":
            case "mng":
            case "mov":
            case "mp2":
            case "mp4":
            case "mpe":
            case "mpeg":
            case "mpg":
            case "mpv":
            case "mxf":
            case "nsv":
            case "ogg":
            case "ogv":
            case "qt":
            case "rm":
            case "rmvb":
            case "roq":
            case "svi":
            case "vob":
            case "webm":
            case "wmv":
            case "yuv":
                return "🎞️";
            case "aa":
            case "aac":
            case "aax":
            case "act":
            case "aiff":
            case "alac":
            case "amr":
            case "ape":
            case "au":
            case "awb":
            case "dss":
            case "dvf":
            case "flac":
            case "gsm":
            case "iklax":
            case "ivs":
            case "m4a":
            case "m4b":
            case "m4p":
            case "mmf":
            case "mp3":
            case "mpc":
            case "msv":
            case "nmf":
            case "ogg":
            case "mogg":
            case "oga":
            case "opus":
            case "org":
            case "ra":
            case "rm":
            case "raw":
            case "rf64":
            case "sln":
            case "tts":
            case "voc":
            case "vox":
            case "wav":
            case "wma":
            case "wv":
            case "webm":
            case "8svx":
            case "cda":
                return "🎧";
            case "rar":
            case "tar":
            case "gz":
            case "7z":
            case "zip":
            case "lzma":
            case "rm":
            case "raw":
            case "rf64":
                return "🗄️"

        }
    }

    return "📄";
}

function formatBytes(bytes) {
    let decimals = 2;
    if (bytes === 0) return "0 Bytes";

    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];

    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
}