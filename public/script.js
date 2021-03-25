// Create websocket connection
let ws;
let wsOpened = false;

const TYPE_PARENT = -1;
const TYPE_FILE = 1;
const TYPE_FOLDER = 2;

let currentList;
let currentQueue;
let isLoadingExplorer = false;

const HTML_ID_QUEUE = "queue";
const HTML_ID_QUEUE_BODY = "queue-body";
const HTML_ID_EXPLORER = "explorer";
const HTML_ID_EXPLORER_BODY = "explorer-body";
const HTML_ID_MESSAGES = "messages";
const HTML_ID_DISCONNECTED = "disconnected";

const HTML_CLASS_LOADING = "loading";
const HTML_CLASS_SUCCESS = "success";
const HTML_CLASS_ERROR = "error";
const HTML_CLASS_MESSAGE = "message";
const HTML_CLASS_HIDE = "hide";

const THEME_DARK = "dark";
const THEME_LIGHT = "light"
const THEME_KEY = "theme"
const DATA_THEME = "data-theme"

const MESSAGE_LIST_ELEMENT = "listElement";
const MESSAGE_QUEUE = "queue";
const MESSAGE_QUEUE_ELEMENT= "queueElement";

const ACTION_LIST = "list";
const ACTION_QUEUE_ADD = "queueAdd";
const ACTION_QUEUE_REMOVE = "queueRemove";
const ACTION_DELETE = "delete";

loadTheme();
connectWebSocket();

function connectWebSocket() {
    ws = new WebSocket(((window.location.protocol === "https:") ? "wss://" : "ws://") + window.location.host + "/ws");

    ws.onmessage = (messageEvent) => {

        let message;

        try {
            message = JSON.parse(messageEvent.data);
        } catch (e) {
            console.error(e);
            return;
        }

        const promise = wsPromises[message.id];
        if (promise) {
            if (message.success) {
                promise.resolve(message.data);
            } else {
                promise.reject(message.error);
            }
            delete wsPromises[message.id];
        }

        switch (message.type) {
            case MESSAGE_LIST_ELEMENT:
                loadListElement(message.data)
                break;
            case MESSAGE_QUEUE:
                loadQueue(message.data)
                break;
            case MESSAGE_QUEUE_ELEMENT:
                loadQueueElement(message.data)
                break;
        }
    }

    ws.onclose = (e) => {
        ws = null;
        console.log('WebSocket connection closed. Reconnecting in 1 second...', e.reason);
        setTimeout(connectWebSocket, 1000);
        showMessage(wsOpened ? "Lost connection" : "Could not connect", true);
        wsOpened = false;
        document.getElementById(HTML_ID_DISCONNECTED).classList.remove(HTML_CLASS_HIDE)
    }

    ws.onerror = (err) => {
        console.log('WebSocket connection error:', err);
        ws.close();
    }

    ws.onopen = () => {
        showMessage("Connected", false);
        wsOpened = true;
        if (!currentList) sendListAction('');
        document.getElementById(HTML_ID_DISCONNECTED).classList.add(HTML_CLASS_HIDE)
    }
}

function loadTheme() {
    const themePref = localStorage.getItem(THEME_KEY);
    if (themePref) toggleDarkMode(themePref === THEME_DARK);
}

// Promisify'd WebSocket reply - response

const MAX_WS_ID = 6969;
const wsPromises = {};
let currentId = 0;

function request(message) {

    return new Promise((resolve, reject) => {

        if (!ws) reject("Not connected")

        const id = currentId++ % MAX_WS_ID;

        wsPromises[id] = {
            resolve: resolve,
            reject: reject
        }

        message.id = id;

        ws.send(JSON.stringify(message))
    })
}

// WebSocket send functions

async function sendListAction(path) {

    showWSNotConnectedErrror();
    if (!ws) return;
    if (isLoadingExplorer) return;

    isLoadingExplorer = true;

    const body = document.getElementById(HTML_ID_EXPLORER_BODY);

    const explorer = document.getElementById(HTML_ID_EXPLORER);
    explorer?.classList.add(HTML_CLASS_LOADING);

    try {
        const list = await request({
            action: ACTION_LIST,
            data: {
                path: path
            }
        })
        loadList(list)
    } catch (e) {
        console.error(e)
    }

    isLoadingExplorer = false;
    explorer?.classList.remove(HTML_CLASS_LOADING);
}

async function sendQueueAddAction(path) {

    showWSNotConnectedErrror();
    if (!ws) return;

    try {
        await request({
            action: ACTION_QUEUE_ADD,
            data: {
                path: path
            }
        })
    } catch (e) {
        console.error(e)
    }
}

async function sendQueueRemoveAction(path) {

    showWSNotConnectedErrror();
    if (!ws) return;

    try {
        await request({
            action: ACTION_QUEUE_REMOVE,
            data: {
                path: path
            }
        })
    } catch (e) {
        console.error(e)
    }
}

async function sendDeleteCommand(path) {

    showWSNotConnectedErrror();
    if (!ws) return;

    try {
        const queueElement = await request({
            action: ACTION_DELETE,
            data: {
                path: path
            }
        })
        console.log(queueElement)
    } catch (e) {
        console.error(e)
    }
}

// Loading explorer list UI

function loadList(data) {
    if (!Array.isArray(data)) return;

    currentList = data

    const body = document.getElementById(HTML_ID_EXPLORER_BODY);

    if (!body) return;

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
            sendQueueAddAction(listElement.path)
    }

    deleteAction.onclick = (event) => {
        event.stopPropagation();
        const doDelete = listElement.existsLocally 
            ? confirm(`Are you sure you want to delete '${listElement.name}'?`)
            : false

        if (doDelete) sendDeleteCommand(listElement.path);
    }

    tr.onclick = () => {
        if (listElement.type === TYPE_FOLDER || listElement.type === TYPE_PARENT)
            sendListAction(listElement.path)
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

    const parent = document.getElementById(HTML_ID_EXPLORER_BODY);
    parent.childNodes[index]?.replaceWith(domElement);
}

// Loading queue UI

function loadQueue(data) {
    if (!Array.isArray(data)) return;

    currentQueue = data

    const body = document.getElementById(HTML_ID_QUEUE_BODY);

    if (!body) return;

    document.getElementById(HTML_ID_QUEUE).classList.remove(HTML_CLASS_LOADING);

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
    const progressDivider = document.createElement("td");
    const total = document.createElement("td");
    const cancelButton = document.createElement("td");

    state.classList.add("state");
    type.classList.add("type");
    name.classList.add("name");
    progress.classList.add("progress");
    progressDivider.classList.add("progress-divider");
    total.classList.add("total");
    cancelButton.classList.add("cancel");

    // Whole row click listener for cancel
    tr.onclick = (event) => {
        event.stopPropagation();
        const doRemove = queueElement.isDownloading 
            ? confirm(`Are you sure you want to cancel downloading '${queueElement.path}'?`) 
            : true;

        if (doRemove) sendQueueRemoveAction(queueElement.path);
    }

    state.innerText = queueElement.isDownloading ? "⬇️" : "⌛";
    state.title = queueElement.isDownloading ? "Item is downloading" : "Item is queued";
    type.innerText = getFileTypeIcon(queueElement.type, queueElement.name)
    name.innerText = queueElement.name;
    name.title = queueElement.path;
    progress.innerText = formatBytes(queueElement.progress);
    total.innerText = formatBytes(queueElement.size);
    progressDivider.innerText = " / "
    cancelButton.innerText = "❌"

    tr.appendChild(state);
    tr.appendChild(type);
    tr.appendChild(name);
    tr.appendChild(progress);
    tr.appendChild(progressDivider);
    tr.appendChild(total);
    tr.appendChild(cancelButton);

    return tr;
}

function toggleDarkMode(force) {

    const theme = typeof force === 'boolean'
        ? force
            ? THEME_DARK
            : THEME_LIGHT
        : document.documentElement.getAttribute(DATA_THEME) !== THEME_LIGHT
            ? THEME_LIGHT
            : THEME_DARK

    document.documentElement.setAttribute(DATA_THEME, theme);
    localStorage.setItem(THEME_KEY, theme);
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

    const parent = document.getElementById(HTML_ID_QUEUE_BODY);
    parent.childNodes[index]?.replaceWith(domElement);
}

function showMessage(data, isError) {

    if (!data) return;

    const messagesContainer = document.getElementById(HTML_ID_MESSAGES)

    const errorEl = document.createElement("div");
    errorEl.classList.add(HTML_CLASS_MESSAGE);
    errorEl.classList.add(isError ? HTML_CLASS_ERROR : HTML_CLASS_SUCCESS);

    errorEl.textContent = data;

    messagesContainer.appendChild(errorEl);

    while (messagesContainer.childElementCount > 50) {
        messagesContainer.removeChild(messagesContainer.firstChild);
    }
}

function showWSNotConnectedErrror() {
    if (!ws) {
        showMessage("Could not complete action, not connected to backend", true);
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