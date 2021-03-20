// Create websocket connection
let ws;

const TYPE_PARENT = -1;
const TYPE_FILE = 1;
const TYPE_FOLDER = 2;

let currentList;
let currentQueue;

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
                    showError(message.data)
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
    }

    ws.onerror = (err) => {
        console.log('WebSocket connection error:', err);
        ws.close();
    }

    ws.onopen = () => {
        console.log('Connected to WebSocket');
        if (!currentList) listPath('');
        listQueue();
    }
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

    while (body.firstChild) body.removeChild(body.firstChild);

    for (let element of data) {

        const tr = document.createElement("tr");

        const exists = document.createElement("td");
        const type = document.createElement("td");
        const name = document.createElement("td");
        const size = document.createElement("td");
        const deleteAction = document.createElement("td");
        const downloadAction = document.createElement("td");

        exists.textContent = element.type !== TYPE_PARENT ? element.existsLocally ? "✅" : "❌" : "";
        type.textContent = getFileTypeIcon(element.type);
        name.textContent = element.name;
        name.title = element.path
        size.textContent = formatBytes(element.size ? element.size : 0);
        size.classList.add("size")
        deleteAction.textContent = "🗑️";
        downloadAction.textContent = "💾"

        tr.appendChild(exists)
        tr.appendChild(type)
        tr.appendChild(name)

        if (element.type === TYPE_FILE) {
            tr.appendChild(size)
        }

        if (element.type !== TYPE_PARENT) {
            tr.appendChild(element.existsLocally ? deleteAction : downloadAction);
        } else {
            name.colSpan = 2;
        }

        downloadAction.onclick = (event) => {
            event.stopPropagation();
            if (!element.existsLocally)
                downloadPath(element.path)
        }

        deleteAction.onclick = (event) => {
            event.stopPropagation();
            if (element.existsLocally) {
                if (confirm(`Are you sure you want to delete '${element.path}'?`)) {
                    deletePath(element.path)
                }
            }
        }

        tr.onclick = () => {
            if (element.type === TYPE_FOLDER || element.type === TYPE_PARENT)
                listPath(element.path)
        }

        body.appendChild(tr)
    }
}

// Update single explorer list element in UI

function loadListElement(data) {

    if (!data || !Array.isArray(currentList)) return;

    for (let element of currentList) {
        if (element.path === data.path) {
            element.existsLocally = data.existsLocally
        }
    }

    loadList(currentList);
}

// Loading queue UI

function loadQueue(data) {
    if (!Array.isArray(data)) return;

    currentQueue = data

    const body = document.getElementById("queue");

    if (!body) return;

    while (body.firstChild) body.removeChild(body.firstChild);

    for (let element of data) {

        const tr = document.createElement("tr");

        const type = document.createElement("td");
        const name = document.createElement("td");
        const progress = document.createElement("td");
        const total = document.createElement("td");
        const cancelButton = document.createElement("td");

        type.innerText = getFileTypeIcon(element.type)
        name.innerText = element.name;
        name.title = element.path;
        progress.innerText = formatBytes(element.progress);
        progress.title = element.progress;
        total.innerText = formatBytes(element.size);
        total.title = element.size;
        cancelButton.innerText = "❌"

        tr.appendChild(type);
        tr.appendChild(name);
        tr.appendChild(progress);
        tr.appendChild(total);
        tr.appendChild(cancelButton);

        tr.onclick = (event) => {
            event.stopPropagation();
            console.log(element)
            if (element.isDownloading) {
                if (confirm(`Are you sure you want to cancel downloading '${element.path}'?`)) {
                    cancelQueueElement(element.path);
                }
            } else {
                cancelQueueElement(element.path);
            }
        }

        body.appendChild(tr);
    }
}

// Update single queue element in UI

function loadQueueElement(data) {

    if (!data || !Array.isArray(currentQueue)) return;

    for (let element of currentQueue) {
        if (element.path === data.path) {
            element.progress = data.progress;
            element.progressUi = formatBytes(data.progress);;
            element.isDownloading = data.isDownloading;
            element.size = data.size;
            element.sizeUi = formatBytes(data.size);
        }
    }

    loadQueue(currentQueue);
}

function showError(data) {

    if (!data) return;

    const oldError = document.getElementById("error");

    if (oldError) document.body.removeChild(oldError)

    const errorEl = document.createElement("div");
    errorEl.id = "error";

    const date = new Date();
    errorEl.textContent = `${date.getHours()}:${date.getMinutes()}:${date.getSeconds()} - ${data}`;

    document.body.appendChild(errorEl)

}

function getFileTypeIcon(fileType) {

    switch (fileType) {
        case TYPE_FILE:
            return "📄";
        case TYPE_FOLDER:
            return "📁";
        case TYPE_PARENT:
            return "⬆️";
        default:
            return "❓";
    }
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